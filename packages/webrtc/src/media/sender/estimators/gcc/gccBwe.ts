import { Event } from "../../../../imports/common";
import type { TransportWideCC } from "../../../../imports/rtp";
import { milliTime } from "../../../../utils";
import type { BandwidthEstimator, SentInfo } from "../../bandwidthEstimator";
import { setAvailableBitrateIfChanged } from "../../bandwidthEstimator";
import { AimdRateControl } from "./aimdRateControl";
import {
  GCC_KNOWN_DIFFERENCES,
  kBitrateWindowMs,
  kBurstTimeMs,
  kDefaultStartBitrateBps,
  kMaxBitrateBps,
  kMinBitrateBps,
  kProbeMinDurationMs,
  kProbeMinPackets,
  kProbePaddingPacketBytes,
  kSentInfoMaxAgeMs,
} from "./constants";
import { LossBasedBwe } from "./lossBasedBwe";
import type { BandwidthUsage } from "./overuseDetector";
import type { ProbeClusterConfig, ProbeState } from "./probeController";
import { ProbeController } from "./probeController";
import { sortPacketResultsByWideSeq } from "./sequenceNumber";
import { TrendlineEstimator } from "./trendlineEstimator";

interface GroupSample {
  sendMs: number;
  recvMs: number;
  size: number;
}

/**
 * Google Congestion Control send-side bandwidth estimator (libwebrtc-aligned).
 *
 * - {@link TrendlineEstimator}: delay gradient + overuse hypothesis
 * - {@link AimdRateControl}: delay-based A_hat
 * - {@link LossBasedBwe}: loss path
 * - {@link ProbeController}: exponential / further probes
 *
 * Bitrate is published only after at least one **known** sent sequence is
 * observed in TWCC (empty / unmatched feedback does not notify).
 */
export class GccBandwidthEstimator implements BandwidthEstimator {
  /** @internal */
  _availableBitrate = 0;

  readonly onAvailableBitrate = new Event<[number]>();
  readonly onOveruseDetected = new Event<[BandwidthUsage]>();
  readonly onProbeClusterConfig = new Event<[ProbeClusterConfig]>();

  private readonly trendline = new TrendlineEstimator();
  private readonly aimd = new AimdRateControl();
  private readonly lossBwe = new LossBasedBwe();
  private readonly probe = new ProbeController();

  private sentInfos = new Map<number, SentInfo>();
  private finalizedSeqs = new Set<number>();
  private prevGroup?: GroupSample;
  private currentGroup?: GroupSample;
  private lastUsage: BandwidthUsage = "normal";
  private ackedBytesWindow: { tMs: number; bytes: number }[] = [];
  private delayBasedBps = kDefaultStartBitrateBps;
  private lossBasedBps = kDefaultStartBitrateBps;
  private startBitrateBps: number;
  private probingConfigured = false;
  /** Valid TWCC samples seen at least once (gates publishing estimates). */
  private hasValidSample = false;
  /** Bytes already sent while the current probe cluster is active. */
  private probeClusterSentBytes = 0;
  private probeClusterStartMs = 0;
  private lastProbeClusterId = 0;

  get availableBitrate() {
    return this._availableBitrate;
  }

  get usageState(): BandwidthUsage {
    return this.trendline.state;
  }

  get probeState(): ProbeState {
    return this.probe.probeState;
  }

  get suggestedProbeBitrateBps() {
    return this.probe.suggestedProbeBitrateBps;
  }

  getPacingBitrateBps(): number {
    const estimate =
      this._availableBitrate > 0 ? this._availableBitrate : this.startBitrateBps;
    const probeTarget = this.probe.currentProbeTargetBps;
    return Math.max(estimate, probeTarget);
  }

  shouldTagProbePacket(): boolean {
    this.ensureProbing(milliTime());
    return this.probe.shouldTagProbePacket();
  }

  /**
   * How many padding packets the sender should inject to progress the active
   * probe cluster when media is sparse. 0 if not probing or cluster is full.
   */
  pendingProbePaddingPackets(
    packetBytes = kProbePaddingPacketBytes,
  ): number {
    this.ensureProbing(milliTime());
    if (!this.probe.shouldTagProbePacket()) return 0;
    const targetBps = this.probe.currentProbeTargetBps;
    if (targetBps <= 0) return 0;

    // Aim for min(minPackets * packetBytes, targetBps * minDuration).
    const minBytes = Math.max(
      kProbeMinPackets * packetBytes,
      Math.ceil((targetBps / 8) * (kProbeMinDurationMs / 1000)),
    );
    const remaining = Math.max(0, minBytes - this.probeClusterSentBytes);
    if (remaining <= 0) return 0;
    return Math.ceil(remaining / packetBytes);
  }

  static readonly knownDifferences = GCC_KNOWN_DIFFERENCES;

  constructor(startBitrateBps = kDefaultStartBitrateBps) {
    this.startBitrateBps = startBitrateBps;
    this.aimd.reset(startBitrateBps);
    this.lossBwe.reset(startBitrateBps);
    this.delayBasedBps = startBitrateBps;
    this.lossBasedBps = startBitrateBps;
  }

  rtpPacketSent(info: SentInfo) {
    this.pruneSentInfos(info.sendingAtMs, info.wideSeq);
    const seq = info.wideSeq & 0xffff;
    this.sentInfos.set(seq, info);
    this.finalizedSeqs.delete(seq);
    this.ensureProbing(info.sendingAtMs);

    // Track probe-cluster fill (media + padding tagged as probation).
    if (info.isProbation && this.probe.shouldTagProbePacket()) {
      const id = this.probe.currentProbeTargetBps; // identity proxy per active target
      if (id !== this.lastProbeClusterId) {
        this.lastProbeClusterId = id;
        this.probeClusterSentBytes = 0;
        this.probeClusterStartMs = info.sendingAtMs;
      }
      this.probeClusterSentBytes += info.size;
    }

    for (const cfg of this.probe.process(info.sendingAtMs)) {
      this.onProbeClusterStarted(cfg, info.sendingAtMs);
    }
  }

  receiveTWCC(feedback: TransportWideCC) {
    const nowMs = milliTime();
    let received = 0;
    let lost = 0;
    let matched = 0;

    const results = sortPacketResultsByWideSeq(feedback.packetResults);

    for (const result of results) {
      const seq = result.sequenceNumber & 0xffff;
      const info = this.sentInfos.get(seq);
      if (!info) {
        // Unknown sequence (swap / late feedback) — do not count as loss.
        continue;
      }
      if (this.finalizedSeqs.has(seq)) {
        continue;
      }

      matched++;
      if (!result.received || !result.receivedAtMs) {
        lost++;
        this.finalizedSeqs.add(seq);
        continue;
      }

      received++;
      this.finalizedSeqs.add(seq);
      this.recordAck(info.size, result.receivedAtMs);
      this.probe.onAckedPacket(
        info.size,
        result.receivedAtMs,
        !!info.isProbation,
      );
      this.pushInterArrival(info.sendingAtMs, result.receivedAtMs, info.size);
    }

    // No known samples → do not update estimate or fire events.
    if (matched === 0) {
      return;
    }
    this.hasValidSample = true;

    const known = received + lost;
    const lossFraction = known > 0 ? lost / known : 0;
    const ackedBps = this.measureAckedBitrate(nowMs);

    this.flushGroup(nowMs);
    const usage = this.trendline.state;
    if (usage !== this.lastUsage) {
      this.lastUsage = usage;
      this.onOveruseDetected.execute(usage);
    }

    this.delayBasedBps = this.aimd.update(usage, ackedBps, nowMs);
    this.lossBasedBps = this.lossBwe.update(
      lossFraction,
      this.delayBasedBps,
      ackedBps,
    );

    let target = Math.min(this.delayBasedBps, this.lossBasedBps);

    const probeBps = this.probe.takePendingEstimateBps();
    if (probeBps > target) {
      target = probeBps;
      this.aimd.reset(probeBps);
      this.lossBwe.reset(probeBps);
      this.delayBasedBps = probeBps;
      this.lossBasedBps = probeBps;
      for (const cfg of this.probe.setEstimatedBitrate(probeBps, nowMs)) {
        this.onProbeClusterStarted(cfg, nowMs);
      }
    }

    if (target > 0 && this.hasValidSample) {
      setAvailableBitrateIfChanged(this, target);
    }

    if (usage === "underuse") {
      for (const cfg of this.probe.requestProbe(
        this._availableBitrate || target,
        nowMs,
      )) {
        this.onProbeClusterStarted(cfg, nowMs);
      }
    }

    for (const cfg of this.probe.process(nowMs)) {
      this.onProbeClusterStarted(cfg, nowMs);
    }
  }

  reset() {
    this.trendline.reset();
    this.aimd.reset(this.startBitrateBps);
    this.lossBwe.reset(this.startBitrateBps);
    this.probe.reset();
    this.sentInfos.clear();
    this.finalizedSeqs.clear();
    this.prevGroup = undefined;
    this.currentGroup = undefined;
    this.lastUsage = "normal";
    this.ackedBytesWindow = [];
    this._availableBitrate = 0;
    this.delayBasedBps = this.startBitrateBps;
    this.lossBasedBps = this.startBitrateBps;
    this.probingConfigured = false;
    this.hasValidSample = false;
    this.probeClusterSentBytes = 0;
    this.probeClusterStartMs = 0;
    this.lastProbeClusterId = 0;
  }

  dispose() {
    this.onAvailableBitrate.allUnsubscribe();
    this.onOveruseDetected.allUnsubscribe();
    this.onProbeClusterConfig.allUnsubscribe();
    this.reset();
  }

  private onProbeClusterStarted(cfg: ProbeClusterConfig, nowMs: number) {
    this.probeClusterSentBytes = 0;
    this.probeClusterStartMs = nowMs;
    this.lastProbeClusterId = cfg.targetBps;
    this.onProbeClusterConfig.execute(cfg);
  }

  private ensureProbing(nowMs: number) {
    if (this.probingConfigured) return;
    this.probingConfigured = true;
    for (const cfg of this.probe.setBitrates(
      kMinBitrateBps,
      this.startBitrateBps,
      kMaxBitrateBps,
      nowMs,
    )) {
      this.onProbeClusterStarted(cfg, nowMs);
    }
  }

  private pruneSentInfos(nowMs: number, latestWideSeq: number) {
    for (const [seq, info] of this.sentInfos) {
      if (nowMs - info.sendingAtMs > kSentInfoMaxAgeMs) {
        this.sentInfos.delete(seq);
        this.finalizedSeqs.delete(seq);
      }
    }
    if (this.sentInfos.size > 4096) {
      const origin = latestWideSeq & 0xffff;
      const keys = [...this.sentInfos.keys()].sort((a, b) => {
        const da = ((a & 0xffff) - origin + 0x10000) % 0x10000;
        const db = ((b & 0xffff) - origin + 0x10000) % 0x10000;
        return db - da;
      });
      for (let i = 0; i < keys.length - 2048; i++) {
        this.sentInfos.delete(keys[i]);
        this.finalizedSeqs.delete(keys[i]);
      }
    }
    if (this.finalizedSeqs.size > 8192) {
      this.finalizedSeqs.clear();
    }
  }

  private recordAck(sizeBytes: number, recvMs: number) {
    this.ackedBytesWindow.push({ tMs: recvMs, bytes: sizeBytes });
    const cutoff = recvMs - kBitrateWindowMs;
    while (
      this.ackedBytesWindow.length &&
      this.ackedBytesWindow[0].tMs < cutoff
    ) {
      this.ackedBytesWindow.shift();
    }
  }

  private measureAckedBitrate(nowMs: number): number {
    const cutoff = nowMs - kBitrateWindowMs;
    let bytes = 0;
    let first = 0;
    let last = 0;
    for (const s of this.ackedBytesWindow) {
      if (s.tMs < cutoff) continue;
      if (first === 0) first = s.tMs;
      last = s.tMs;
      bytes += s.bytes;
    }
    const dt = Math.max(last - first, 1);
    if (bytes === 0) return 0;
    return (bytes * 8 * 1000) / dt;
  }

  private pushInterArrival(sendMs: number, recvMs: number, size: number) {
    if (!this.currentGroup) {
      this.currentGroup = { sendMs, recvMs, size };
      return;
    }

    const interSend = sendMs - this.currentGroup.sendMs;
    const interRecv = recvMs - this.currentGroup.recvMs;
    const d = interRecv - interSend;

    const sameBurst =
      interSend <= kBurstTimeMs || (interRecv < kBurstTimeMs && d < 0);

    if (sameBurst) {
      this.currentGroup.sendMs = sendMs;
      this.currentGroup.recvMs = recvMs;
      this.currentGroup.size += size;
      return;
    }

    this.emitGroup(this.currentGroup);
    this.currentGroup = { sendMs, recvMs, size };
  }

  private flushGroup(nowMs: number) {
    if (this.currentGroup) {
      this.emitGroup(this.currentGroup, nowMs);
    }
  }

  private emitGroup(group: GroupSample, nowMs?: number) {
    if (this.prevGroup) {
      const interSend = group.sendMs - this.prevGroup.sendMs;
      const interRecv = group.recvMs - this.prevGroup.recvMs;
      if (interSend > 0) {
        const ts = nowMs ?? group.recvMs;
        // Trendline owns overuse detection (libwebrtc).
        this.trendline.update(interRecv, interSend, ts);
      }
    }
    this.prevGroup = group;
  }
}

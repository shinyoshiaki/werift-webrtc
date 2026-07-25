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
  kSentInfoMaxAgeMs,
} from "./constants";
import { LossBasedBwe } from "./lossBasedBwe";
import type { BandwidthUsage } from "./overuseDetector";
import { OveruseDetector } from "./overuseDetector";
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
 * Components:
 * - {@link TrendlineEstimator} delay gradient (libwebrtc, not draft Kalman)
 * - {@link OveruseDetector} + {@link AimdRateControl}
 * - {@link LossBasedBwe} threshold/state loss path
 * - {@link ProbeController} exponential / further probes
 *
 * Final estimate: `min(delay-based, loss-based)`, raised by successful probes.
 * While a probe cluster is active, {@link getPacingBitrateBps} returns the probe
 * target so {@link RTCRtpSender} can pace/send at the exploratory rate.
 *
 * Loss is computed only over transport-wide sequences this estimator has sent
 * and not yet finalized; unknown / late / duplicate feedback is ignored.
 */
export class GccBandwidthEstimator implements BandwidthEstimator {
  /** @internal */
  _availableBitrate = 0;

  readonly onAvailableBitrate = new Event<[number]>();

  /** GCC-only: overuse detector hypothesis changes. */
  readonly onOveruseDetected = new Event<[BandwidthUsage]>();

  /**
   * GCC-only: probe cluster configs the sender/pacer should execute
   * (target bitrate, min packets/duration).
   */
  readonly onProbeClusterConfig = new Event<[ProbeClusterConfig]>();

  private readonly trendline = new TrendlineEstimator();
  private readonly overuse = new OveruseDetector();
  private readonly aimd = new AimdRateControl();
  private readonly lossBwe = new LossBasedBwe();
  private readonly probe = new ProbeController();

  private sentInfos = new Map<number, SentInfo>();
  /** Sequences already counted as received or lost (dedupe delayed TWCC). */
  private finalizedSeqs = new Set<number>();
  private prevGroup?: GroupSample;
  private currentGroup?: GroupSample;
  private lastUsage: BandwidthUsage = "normal";
  private ackedBytesWindow: { tMs: number; bytes: number }[] = [];
  private delayBasedBps = kDefaultStartBitrateBps;
  private lossBasedBps = kDefaultStartBitrateBps;
  private startBitrateBps: number;
  private probingConfigured = false;

  get availableBitrate() {
    return this._availableBitrate;
  }

  get usageState(): BandwidthUsage {
    return this.overuse.state;
  }

  get probeState(): ProbeState {
    return this.probe.probeState;
  }

  get suggestedProbeBitrateBps() {
    return this.probe.suggestedProbeBitrateBps;
  }

  /**
   * Bitrate the sender should pace at now: max(estimate, active probe target).
   * Used by {@link RTCRtpSender} token-bucket pacing during probe clusters.
   */
  getPacingBitrateBps(): number {
    const estimate = this._availableBitrate || this.startBitrateBps;
    const probeTarget = this.probe.currentProbeTargetBps;
    return Math.max(estimate, probeTarget);
  }

  shouldTagProbePacket(): boolean {
    this.ensureProbing(milliTime());
    return this.probe.shouldTagProbePacket();
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
    // New send invalidates any stale finalized flag for this seq (wrap reuse).
    this.finalizedSeqs.delete(seq);
    this.ensureProbing(info.sendingAtMs);
    for (const cfg of this.probe.process(info.sendingAtMs)) {
      this.onProbeClusterConfig.execute(cfg);
    }
  }

  receiveTWCC(feedback: TransportWideCC) {
    const nowMs = milliTime();
    let received = 0;
    let lost = 0;

    const results = sortPacketResultsByWideSeq(feedback.packetResults);

    for (const result of results) {
      const seq = result.sequenceNumber & 0xffff;

      // Only sequences this estimator has actually sent count toward loss / delay.
      const info = this.sentInfos.get(seq);
      if (!info) {
        continue;
      }

      // Duplicate / delayed re-delivery of the same feedback: ignore.
      if (this.finalizedSeqs.has(seq)) {
        continue;
      }

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

    const known = received + lost;
    const lossFraction = known > 0 ? lost / known : 0;
    const ackedBps = this.measureAckedBitrate(nowMs);

    this.flushGroup(nowMs);
    const usage = this.overuse.state;
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
        this.onProbeClusterConfig.execute(cfg);
      }
    }

    if (target > 0) {
      setAvailableBitrateIfChanged(this, target);
    }

    // Recovery / underuse → request additional probe clusters.
    if (usage === "underuse") {
      for (const cfg of this.probe.requestProbe(
        this._availableBitrate || target,
        nowMs,
      )) {
        this.onProbeClusterConfig.execute(cfg);
      }
    }

    for (const cfg of this.probe.process(nowMs)) {
      this.onProbeClusterConfig.execute(cfg);
    }
  }

  reset() {
    this.trendline.reset();
    this.overuse.reset();
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
  }

  dispose() {
    this.onAvailableBitrate.allUnsubscribe();
    this.onOveruseDetected.allUnsubscribe();
    this.onProbeClusterConfig.allUnsubscribe();
    this.reset();
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
      this.onProbeClusterConfig.execute(cfg);
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
    // Bound finalized set similarly.
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
        const offset = this.trendline.update(interRecv, interSend, ts);
        this.overuse.detect(offset, ts);
      }
    }
    this.prevGroup = group;
  }
}

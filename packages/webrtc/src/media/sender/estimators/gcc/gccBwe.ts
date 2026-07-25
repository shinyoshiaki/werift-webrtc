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
  kSentInfoMaxAgeMs,
} from "./constants";
import { KalmanArrivalFilter } from "./kalmanArrivalFilter";
import { LossBasedBwe } from "./lossBasedBwe";
import type { BandwidthUsage } from "./overuseDetector";
import { OveruseDetector } from "./overuseDetector";
import { ProbeController } from "./probeController";
import { sortPacketResultsByWideSeq } from "./sequenceNumber";

interface GroupSample {
  sendMs: number;
  recvMs: number;
  size: number;
}

/**
 * Google Congestion Control send-side bandwidth estimator.
 *
 * Combines delay-based (Kalman + overuse + AIMD), loss-based (draft §6),
 * and probe estimation. Final target is `min(delay, loss)`, optionally raised
 * by a successful probe. Implements {@link BandwidthEstimator}.
 *
 * GCC-specific signals are exposed via `onOveruseDetected` / `usageState` /
 * `probeState` and are **not** part of the shared interface.
 *
 * @see https://datatracker.ietf.org/doc/html/draft-ietf-rmcat-gcc-02
 * @see GCC_KNOWN_DIFFERENCES
 */
export class GccBandwidthEstimator implements BandwidthEstimator {
  /** @internal */
  _availableBitrate = 0;

  /**
   * Fires when recommended send bitrate (**bps**) changes.
   * @see BandwidthEstimator.onAvailableBitrate
   */
  readonly onAvailableBitrate = new Event<[number]>();

  /**
   * GCC-only: fires when the overuse detector hypothesis changes
   * (`normal` / `overuse` / `underuse`).
   */
  readonly onOveruseDetected = new Event<[BandwidthUsage]>();

  private readonly kalman = new KalmanArrivalFilter();
  private readonly overuse = new OveruseDetector();
  private readonly aimd = new AimdRateControl();
  private readonly lossBwe = new LossBasedBwe();
  private readonly probe = new ProbeController();

  private sentInfos = new Map<number, SentInfo>();
  private prevGroup?: GroupSample;
  private currentGroup?: GroupSample;
  private lastUsage: BandwidthUsage = "normal";
  private ackedBytesWindow: { tMs: number; bytes: number }[] = [];
  private delayBasedBps = kDefaultStartBitrateBps;
  private lossBasedBps = kDefaultStartBitrateBps;

  get availableBitrate() {
    return this._availableBitrate;
  }

  /** Current overuse-detector hypothesis (GCC-specific). */
  get usageState(): BandwidthUsage {
    return this.overuse.state;
  }

  /** Current probe controller state (GCC-specific). */
  get probeState() {
    return this.probe.probeState;
  }

  /** Advisory probe target bitrate while probing (0 if idle). */
  get suggestedProbeBitrateBps() {
    return this.probe.suggestedProbeBitrateBps;
  }

  /** Documented intentional differences vs libwebrtc / draft. */
  static readonly knownDifferences = GCC_KNOWN_DIFFERENCES;

  constructor(startBitrateBps = kDefaultStartBitrateBps) {
    this.aimd.reset(startBitrateBps);
    this.lossBwe.reset(startBitrateBps);
    this.delayBasedBps = startBitrateBps;
    this.lossBasedBps = startBitrateBps;
  }

  rtpPacketSent(info: SentInfo) {
    this.pruneSentInfos(info.sendingAtMs, info.wideSeq);
    this.sentInfos.set(info.wideSeq & 0xffff, info);
  }

  /**
   * Tag outgoing RTP as probe while a probe cluster is active.
   * Opens a cold-start probe cluster if none is running yet so the first
   * tagged packets can contribute to the probe estimate.
   */
  shouldTagProbePacket(): boolean {
    if (this._availableBitrate === 0 && this.probe.probeState === "idle") {
      this.probe.maybeStartProbe(kDefaultStartBitrateBps, milliTime());
    }
    return this.probe.shouldTagProbePacket();
  }

  receiveTWCC(feedback: TransportWideCC) {
    const nowMs = milliTime();
    let received = 0;
    let lost = 0;

    // Process in transport-wide send order (wrap-around safe).
    const results = sortPacketResultsByWideSeq(feedback.packetResults);

    for (const result of results) {
      if (!result.received) {
        lost++;
        continue;
      }
      received++;
      const info = this.sentInfos.get(result.sequenceNumber & 0xffff);
      if (!info || !result.receivedAtMs) continue;

      this.recordAck(info.size, result.receivedAtMs);
      this.probe.onAckedPacket(
        info.size,
        result.receivedAtMs,
        !!info.isProbation,
      );
      this.pushInterArrival(info.sendingAtMs, result.receivedAtMs, info.size);
    }

    const lossFraction =
      received + lost > 0 ? lost / (received + lost) : 0;
    const ackedBps = this.measureAckedBitrate(nowMs);

    // Delay-based path: flush current group and run filter / detector / AIMD.
    this.flushGroup(nowMs);
    const usage = this.overuse.state;
    if (usage !== this.lastUsage) {
      this.lastUsage = usage;
      this.onOveruseDetected.execute(usage);
    }

    this.delayBasedBps = this.aimd.update(usage, ackedBps, nowMs);
    this.lossBasedBps = this.lossBwe.update(lossFraction, this.delayBasedBps);

    // Final target: min(delay-based, loss-based) per draft §6.
    let target = Math.min(this.delayBasedBps, this.lossBasedBps);

    // Apply a newly completed probe once (capacity discovery); do not re-apply
    // on every subsequent feedback, which would undo loss/overuse decreases.
    const probeBps = this.probe.takePendingEstimateBps();
    if (probeBps > target) {
      target = probeBps;
      this.aimd.reset(probeBps);
      this.lossBwe.reset(probeBps);
      this.delayBasedBps = probeBps;
      this.lossBasedBps = probeBps;
    }

    if (target > 0) {
      setAvailableBitrateIfChanged(this, target);
    }

    // Restart probe after recovery (underuse) or while still near cold start.
    if (
      usage === "underuse" ||
      (this._availableBitrate > 0 &&
        this._availableBitrate < kDefaultStartBitrateBps)
    ) {
      this.probe.maybeStartProbe(this._availableBitrate || target, nowMs);
    }
  }

  reset() {
    this.kalman.reset();
    this.overuse.reset();
    this.aimd.reset();
    this.lossBwe.reset();
    this.probe.reset();
    this.sentInfos.clear();
    this.prevGroup = undefined;
    this.currentGroup = undefined;
    this.lastUsage = "normal";
    this.ackedBytesWindow = [];
    this._availableBitrate = 0;
    this.delayBasedBps = kDefaultStartBitrateBps;
    this.lossBasedBps = kDefaultStartBitrateBps;
  }

  dispose() {
    this.onAvailableBitrate.allUnsubscribe();
    this.onOveruseDetected.allUnsubscribe();
    this.reset();
  }

  private pruneSentInfos(nowMs: number, latestWideSeq: number) {
    // Age-based eviction.
    for (const [seq, info] of this.sentInfos) {
      if (nowMs - info.sendingAtMs > kSentInfoMaxAgeMs) {
        this.sentInfos.delete(seq);
      }
    }
    // Bound map size by dropping oldest keys relative to latest (wrap-aware order).
    // Keep a reordering window of ~2048 transport-wide sequence numbers.
    if (this.sentInfos.size > 4096) {
      const origin = latestWideSeq & 0xffff;
      const keys = [...this.sentInfos.keys()].sort((a, b) => {
        const da = ((a & 0xffff) - origin + 0x10000) % 0x10000;
        const db = ((b & 0xffff) - origin + 0x10000) % 0x10000;
        // Larger distance from origin means older when origin is the newest.
        return db - da;
      });
      for (let i = 0; i < keys.length - 2048; i++) {
        this.sentInfos.delete(keys[i]);
      }
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

  /**
   * Pre-filtering / grouping (draft §5.2) then inter-group delay variation.
   */
  private pushInterArrival(sendMs: number, recvMs: number, size: number) {
    if (!this.currentGroup) {
      this.currentGroup = { sendMs, recvMs, size };
      return;
    }

    const interSend = sendMs - this.currentGroup.sendMs;
    const interRecv = recvMs - this.currentGroup.recvMs;
    const d = interRecv - interSend;

    const sameBurst =
      interSend <= kBurstTimeMs ||
      (interRecv < kBurstTimeMs && d < 0);

    if (sameBurst) {
      // Merge into current group (last packet defines times).
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
      // Keep current group as prev baseline only via emitGroup.
    }
  }

  private emitGroup(group: GroupSample, nowMs?: number) {
    if (this.prevGroup) {
      const interSend = group.sendMs - this.prevGroup.sendMs;
      const interRecv = group.recvMs - this.prevGroup.recvMs;
      if (interSend > 0) {
        const d = interRecv - interSend;
        const ts = nowMs ?? group.recvMs;
        const mHat = this.kalman.update(d, ts);
        this.overuse.detect(mHat, ts);
      }
    }
    this.prevGroup = group;
  }
}

import { Event } from "../../../../imports/common";
import type { TransportWideCC } from "../../../../imports/rtp";
import { milliTime } from "../../../../utils";
import type {
  BandwidthEstimator,
  ProbePacingController,
  SentInfo,
} from "../../bandwidthEstimator";
import { setAvailableBitrateIfChanged } from "../../bandwidthEstimator";
import { hasTwccReceiveTiming } from "../twccReceiveTiming";
import { TwccReferenceTimeUnwrapper } from "../twccReferenceTime";
import { AimdRateControl } from "./aimdRateControl";
import {
  GCC_KNOWN_DIFFERENCES,
  kBitrateWindowMs,
  kDefaultRttMs,
  kDefaultStartBitrateBps,
  kMaxBitrateBps,
  kMinBitrateBps,
  kProbeAbortLossFraction,
  kProbePaddingPacketBytes,
  kProbeResultMaxOverAcked,
  kProbeResultMaxOverTarget,
  kSentInfoMaxAgeMs,
} from "./constants";
import { InterArrivalDelta } from "./interArrivalDelta";
import { LossBasedBwe, type LossPacketFeedback } from "./lossBasedBwe";
import type { BandwidthUsage } from "./overuseDetector";
import type { ProbeClusterConfig, ProbeState } from "./probeController";
import { ProbeController } from "./probeController";
import { sortPacketResultsByWideSeq } from "./sequenceNumber";
import { TrendlineEstimator } from "./trendlineEstimator";

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
export class GccBandwidthEstimator
  implements BandwidthEstimator, ProbePacingController
{
  /** @internal */
  _availableBitrate = 0;

  readonly onAvailableBitrate = new Event<[number]>();
  readonly onOveruseDetected = new Event<[BandwidthUsage]>();
  readonly onProbeClusterConfig = new Event<[ProbeClusterConfig]>();

  private readonly trendline = new TrendlineEstimator();
  private readonly aimd = new AimdRateControl();
  private readonly lossBwe = new LossBasedBwe();
  private readonly probe = new ProbeController();
  private readonly interArrival = new InterArrivalDelta();
  /** Unwraps 24-bit TWCC reference_time across feedbacks. */
  private readonly refTimeUnwrapper = new TwccReferenceTimeUnwrapper();

  private sentInfos = new Map<number, SentInfo>();
  /**
   * Sequences finalized as **received**. Not-received is never permanently
   * finalized — a later feedback may report the same seq as received
   * (TWCC PacketNotReceived ≠ definitive loss).
   */
  private finalizedSeqs = new Set<number>();
  private lastUsage: BandwidthUsage = "normal";
  private ackedBytesWindow: { tMs: number; bytes: number }[] = [];
  private delayBasedBps = kDefaultStartBitrateBps;
  private lossBasedBps = kDefaultStartBitrateBps;
  private startBitrateBps: number;
  private probingConfigured = false;
  /**
   * False until the first exponential probe session reaches `complete`.
   * Probe-result target×1.5 cap is applied only after this becomes true, so
   * cold-start ×3/×6 exploration is not clipped to start×1.5.
   */
  private initialExponentialDone = false;
  /** Valid TWCC samples seen at least once (gates publishing estimates). */
  private hasValidSample = false;
  /** Bytes already sent while any probe cluster is active. */
  private probeClusterSentBytes = 0;
  private probeClusterStartMs = 0;
  private lastProbeTargetBps = 0;

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
      this._availableBitrate > 0
        ? this._availableBitrate
        : this.startBitrateBps;
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
  pendingProbePaddingPackets(packetBytes = kProbePaddingPacketBytes): number {
    this.ensureProbing(milliTime());
    if (!this.probe.shouldTagProbePacket()) return 0;
    const remaining = this.probe.remainingProbeBytes(packetBytes);
    if (remaining <= 0) return 0;
    return Math.ceil(remaining / Math.max(1, packetBytes));
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
    // Re-sending the same wide-seq (after wrap / reuse) clears prior finalize.
    this.finalizedSeqs.delete(seq);
    this.ensureProbing(info.sendingAtMs);

    // Assign probation packets to the **pacing** cluster (wideSeq → id).
    // On send-fill complete, FIFO advances to the next cluster (no ACK wait).
    if (info.isProbation && this.probe.shouldTagProbePacket()) {
      const { activated } = this.probe.onProbePacketSent(
        info.size,
        info.sendingAtMs,
        seq,
      );
      this.probeClusterSentBytes += info.size;
      for (const cfg of activated) {
        this.onProbeClusterActivated(cfg, info.sendingAtMs);
      }
    }

    for (const cfg of this.probe.process(info.sendingAtMs)) {
      this.onProbeClusterActivated(cfg, info.sendingAtMs);
    }
  }

  receiveTWCC(feedback: TransportWideCC) {
    const nowMs = milliTime();
    let received = 0;
    let lost = 0;
    let matched = 0;
    let lostBytes = 0;
    let batchBytes = 0;
    let firstSend = Number.POSITIVE_INFINITY;
    let lastSend = 0;
    const lossPackets: LossPacketFeedback[] = [];

    // Expand 24-bit reference_time across feedbacks so receivedAtMs stays
    // continuous through wrap (0xFFFFFF → 0).
    const rebased = this.refTimeUnwrapper.rebasePacketResults(
      feedback.packetResults,
      feedback.referenceTime,
    );
    const results = sortPacketResultsByWideSeq(rebased);

    for (const result of results) {
      const seq = result.sequenceNumber & 0xffff;
      const info = this.sentInfos.get(seq);
      if (!info) {
        // Unknown sequence (swap / late feedback) — do not count as loss.
        continue;
      }
      if (this.finalizedSeqs.has(seq)) {
        // Already confirmed received — ignore duplicate / overlapping reports.
        continue;
      }

      matched++;
      batchBytes += info.size;
      if (info.sendingAtMs < firstSend) firstSend = info.sendingAtMs;
      if (info.sendingAtMs > lastSend) lastSend = info.sendingAtMs;

      if (!result.received) {
        // Soft loss: count for this observation, do NOT permanently finalize.
        lost++;
        lostBytes += info.size;
        lossPackets.push({
          seq,
          size: info.size,
          received: false,
          sendMs: info.sendingAtMs,
        });
        continue;
      }

      // Received — may unmark a prior soft loss inside LossBasedBwe partial map.
      received++;
      this.finalizedSeqs.add(seq);
      lossPackets.push({
        seq,
        size: info.size,
        received: true,
        sendMs: info.sendingAtMs,
      });

      // ReceivedWithoutDelta / no timing: received for loss only, skip delay path.
      // Do not use falsy `!receivedAtMs` — 0 is a valid reference-relative time.
      if (!hasTwccReceiveTiming(result)) {
        continue;
      }

      this.recordAck(info.size, result.receivedAtMs);
      // Result validation only (sender clock for session complete/cooldown).
      // FIFO pacing advance happens on send-fill, not on ACK.
      this.probe.onAckedPacket(
        info.size,
        result.receivedAtMs,
        !!info.isProbation,
        seq,
        nowMs,
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

    const usage = this.trendline.state;
    if (usage !== this.lastUsage) {
      this.lastUsage = usage;
      this.onOveruseDetected.execute(usage);
    }

    // Stop probe padding immediately under clear congestion so recovery
    // does not re-flood a capacity-limited link.
    const congested =
      usage === "overuse" || lossFraction >= kProbeAbortLossFraction;
    if (congested && this.probe.shouldTagProbePacket()) {
      this.probe.abort(nowMs);
      this.probeClusterSentBytes = 0;
      this.lastProbeTargetBps = 0;
    }

    const batchFirstSend = Number.isFinite(firstSend) ? firstSend : 0;
    const batchLastSend = lastSend > 0 ? lastSend : batchFirstSend;

    // RTT proxy: feedback arrival wall time − last send of this batch.
    // Not full ICE/STUN RTT; used for AIMD decrease spacing (TimeToReduceFurther).
    if (batchLastSend > 0) {
      const rttProxy = nowMs - batchLastSend;
      if (rttProxy >= 10 && rttProxy <= 2000) {
        this.aimd.setRtt(Math.max(kDefaultRttMs, rttProxy));
      }
    }

    this.delayBasedBps = this.aimd.update(usage, ackedBps, nowMs);
    this.lossBasedBps = this.lossBwe.update(
      lossFraction,
      this.delayBasedBps,
      ackedBps,
      known,
      lost,
      batchFirstSend,
      batchBytes,
      batchLastSend,
      lostBytes,
      lossPackets,
    );

    let target = Math.min(this.delayBasedBps, this.lossBasedBps);

    // Apply probe result only when the path is not congested.
    // Cap policy differs by phase (use {@link initialExponentialDone}, not
    // probeState alone — completion and takePending happen in the same TWCC):
    // - Initial exponential: accept measured rate with acked soft ceiling only
    //   so ×3/×6 can raise the estimate well above start.
    // - Recovery: also cap vs delay/loss target so probes cannot re-flood.
    const probeBps = this.probe.takePendingEstimateBps();
    if (probeBps > target && !congested) {
      const initialProbing = !this.initialExponentialDone;
      let accepted = Math.min(probeBps, kMaxBitrateBps);
      if (initialProbing) {
        if (ackedBps > kMinBitrateBps) {
          accepted = Math.min(accepted, ackedBps * kProbeResultMaxOverAcked);
        }
      } else {
        // Recovery: min(probe, max(target×1.5, acked×2)).
        const targetCap = target * kProbeResultMaxOverTarget;
        const ackedCap =
          ackedBps > kMinBitrateBps
            ? ackedBps * kProbeResultMaxOverAcked
            : targetCap;
        accepted = Math.min(accepted, Math.max(targetCap, ackedCap));
      }
      if (accepted > target) {
        target = accepted;
        this.aimd.reset(accepted);
        this.lossBwe.reset(accepted);
        this.delayBasedBps = accepted;
        this.lossBasedBps = accepted;
        for (const cfg of this.probe.setEstimatedBitrate(accepted, nowMs)) {
          this.onProbeClusterActivated(cfg, nowMs);
        }
      }
    }

    if (this.probe.probeState === "complete") {
      this.initialExponentialDone = true;
    }

    if (target > 0 && this.hasValidSample) {
      setAvailableBitrateIfChanged(this, target);
    }

    // Recovery probe only after initial probing is complete, delay path
    // reports underuse, and loss is not the binding constraint.
    const lossBinding = this.lossBasedBps < this.delayBasedBps * 0.98;
    if (
      usage === "underuse" &&
      this.probe.probeState === "complete" &&
      !congested &&
      !lossBinding
    ) {
      const est = this._availableBitrate > 0 ? this._availableBitrate : target;
      for (const cfg of this.probe.requestProbe(est, nowMs)) {
        this.onProbeClusterActivated(cfg, nowMs);
      }
    }

    for (const cfg of this.probe.process(nowMs)) {
      this.onProbeClusterActivated(cfg, nowMs);
    }
  }

  reset() {
    this.trendline.reset();
    this.aimd.reset(this.startBitrateBps);
    this.lossBwe.reset(this.startBitrateBps);
    this.probe.reset();
    this.interArrival.reset();
    this.refTimeUnwrapper.reset();
    this.sentInfos.clear();
    this.finalizedSeqs.clear();
    this.lastUsage = "normal";
    this.ackedBytesWindow = [];
    this._availableBitrate = 0;
    this.delayBasedBps = this.startBitrateBps;
    this.lossBasedBps = this.startBitrateBps;
    this.probingConfigured = false;
    this.initialExponentialDone = false;
    this.hasValidSample = false;
    this.probeClusterSentBytes = 0;
    this.probeClusterStartMs = 0;
    this.lastProbeTargetBps = 0;
  }

  dispose() {
    this.onAvailableBitrate.allUnsubscribe();
    this.onOveruseDetected.allUnsubscribe();
    this.onProbeClusterConfig.allUnsubscribe();
    this.reset();
  }

  /**
   * Fired only when a cluster becomes the **pacing** front (activated).
   * RTCRtpSender uses this for pace budget + padding injection — not for
   * queued-but-not-yet-active configs (e.g. 6x while 3x is still sending).
   */
  private onProbeClusterActivated(cfg: ProbeClusterConfig, nowMs: number) {
    this.probeClusterSentBytes = 0;
    this.probeClusterStartMs = nowMs;
    this.lastProbeTargetBps = cfg.targetBps;
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
      this.onProbeClusterActivated(cfg, nowMs);
    }
  }

  /**
   * Drop aged entries and keep only the **most recent** {@link keepWindow}
   * sequences measured by wrap-aware **backward** distance from
   * `latestWideSeq` (0 = latest). Using forward distance wrongly deleted
   * recent packets and retained the oldest half of the ring.
   */
  private pruneSentInfos(nowMs: number, latestWideSeq: number) {
    const keepWindow = 2048;
    for (const [seq, info] of this.sentInfos) {
      if (nowMs - info.sendingAtMs > kSentInfoMaxAgeMs) {
        this.sentInfos.delete(seq);
        this.finalizedSeqs.delete(seq);
      }
    }
    if (this.sentInfos.size <= keepWindow) {
      if (this.finalizedSeqs.size > 8192) this.finalizedSeqs.clear();
      return;
    }
    const origin = latestWideSeq & 0xffff;
    for (const seq of [...this.sentInfos.keys()]) {
      const s = seq & 0xffff;
      // How many sequence steps **before** origin (wrap-aware). 0 = latest.
      const back = (origin - s + 0x10000) % 0x10000;
      if (back >= keepWindow) {
        this.sentInfos.delete(seq);
        this.finalizedSeqs.delete(seq);
      }
    }
    if (this.finalizedSeqs.size > 8192) {
      this.finalizedSeqs.clear();
    }
  }

  /**
   * Record an acked packet using TWCC receive timeline only.
   * `recvMs` is the feedback-derived receive timestamp (referenceTime + deltas),
   * not the sender wall clock — so real sessions where TWCC times are far from
   * `Date.now()` still yield a valid throughput estimate.
   */
  private recordAck(sizeBytes: number, recvMs: number) {
    this.ackedBytesWindow.push({ tMs: recvMs, bytes: sizeBytes });
    // Prune using the latest TWCC-relative time in the window (not wall clock).
    let latest = recvMs;
    for (const s of this.ackedBytesWindow) {
      if (s.tMs > latest) latest = s.tMs;
    }
    const cutoff = latest - kBitrateWindowMs;
    while (
      this.ackedBytesWindow.length &&
      this.ackedBytesWindow[0].tMs < cutoff
    ) {
      this.ackedBytesWindow.shift();
    }
  }

  /**
   * Acknowledged bitrate from TWCC receive-time intervals and packet sizes.
   * Does **not** compare TWCC timestamps to sender wall clock.
   */
  private measureAckedBitrate(_nowMs?: number): number {
    if (this.ackedBytesWindow.length === 0) return 0;
    let bytes = 0;
    let first = this.ackedBytesWindow[0].tMs;
    let last = this.ackedBytesWindow[0].tMs;
    for (const s of this.ackedBytesWindow) {
      bytes += s.bytes;
      if (s.tMs < first) first = s.tMs;
      if (s.tMs > last) last = s.tMs;
    }
    const dt = last - first;
    if (bytes === 0) return 0;
    // Single-sample or zero-duration window: treat as instantaneous over 1 ms.
    const intervalMs = Math.max(dt, 1);
    return (bytes * 8 * 1000) / intervalMs;
  }

  private pushInterArrival(sendMs: number, recvMs: number, size: number) {
    const deltas = this.interArrival.computeDeltas(sendMs, recvMs, size);
    if (deltas) {
      this.trendline.update(deltas.recvDeltaMs, deltas.sendDeltaMs, recvMs);
    }
  }
}

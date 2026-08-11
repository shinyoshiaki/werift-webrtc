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
import { AcknowledgedBitrateEstimator } from "./acknowledgedBitrateEstimator";
import { AimdRateControl } from "./aimdRateControl";
import {
  getBandwidthLimitedCause,
  isProbeInitiationAllowed,
  isRttAboveLimit,
  maxProbeBitrateBps,
} from "./bandwidthLimitedCause";
import {
  GCC_KNOWN_DIFFERENCES,
  kDefaultRttMs,
  kDefaultStartBitrateBps,
  kMaxBitrateBps,
  kMinBitrateBps,
  kProbeDropThroughputFraction,
  kProbePaddingPacketBytes,
  kProbeResultMaxOverAcked,
  kProbeResultMaxOverTarget,
  kRttBasedBackOffBandwidthFloorBps,
  kRttBasedBackOffDropFraction,
  kRttBasedBackOffDropIntervalMs,
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
  /**
   * Sequences already reported as soft loss. Keep them eligible for a later
   * received correction, but do not count overlapping not-received feedback
   * more than once (libwebrtc `previously_reported_lost`).
   */
  private softLostSeqs = new Set<number>();
  private lastUsage: BandwidthUsage = "normal";
  /**
   * libwebrtc RobustThroughputEstimator (default acked bitrate path).
   * Fed receive-time-ordered ACKs; does not mix sender wall clock.
   */
  private readonly ackedBitrate = new AcknowledgedBitrateEstimator();
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
  /**
   * Feedback RTT proxy = feedback arrival − **earliest send among received**
   * packets in the TWCC batch (libwebrtc max_feedback_rtt). Refreshed on every
   * finite sample (clamped ≥0). Used for IsRttAboveLimit (3s).
   * AIMD keeps a separately clamped RTT for TimeToReduceFurther only.
   */
  private lastFeedbackRttMs = kDefaultRttMs;
  /** Sender-clock time of last RttBasedBackoff target drop. */
  private lastRttBackoffDecreaseMs = Number.NEGATIVE_INFINITY;

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
    this.softLostSeqs.delete(seq);
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
    /**
     * Earliest send among **received** packets in this feedback.
     * libwebrtc max_feedback_rtt = max_i (feedback_time − send_i)
     * = feedback_time − min(send_i) over ReceivedWithSendInfo.
     */
    let earliestReceivedSend = Number.POSITIVE_INFINITY;
    const lossPackets: LossPacketFeedback[] = [];

    // Expand 24-bit reference_time across feedbacks so receivedAtMs stays
    // continuous through wrap (0xFFFFFF → 0).
    const rebased = this.refTimeUnwrapper.rebasePacketResults(
      feedback.packetResults,
      feedback.referenceTime,
    );
    // Loss / soft-loss path: transport-seq (send) order is stable and matches
    // sentInfos. Delay + acked + probe use receive-time order below (libwebrtc
    // SortedByReceiveTime for those subsystems).
    const results = sortPacketResultsByWideSeq(rebased);

    /** Received packets with valid TWCC timing for delay / acked / probe. */
    const timedReceived: {
      seq: number;
      size: number;
      sendMs: number;
      recvMs: number;
      isProbation: boolean;
    }[] = [];

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
      if (!result.received && this.softLostSeqs.has(seq)) {
        // A repeated not-received report is not a new loss observation; keep
        // the sequence open for a later received correction.
        continue;
      }

      matched++;
      batchBytes += info.size;
      if (info.sendingAtMs < firstSend) firstSend = info.sendingAtMs;
      if (info.sendingAtMs > lastSend) lastSend = info.sendingAtMs;

      if (!result.received) {
        // Soft loss: count for this observation, do NOT permanently finalize.
        this.softLostSeqs.add(seq);
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
      this.softLostSeqs.delete(seq);
      if (info.sendingAtMs < earliestReceivedSend) {
        earliestReceivedSend = info.sendingAtMs;
      }
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

      timedReceived.push({
        seq,
        size: info.size,
        sendMs: info.sendingAtMs,
        recvMs: result.receivedAtMs,
        isProbation: !!info.isProbation,
      });
    }

    // No known samples → do not update estimate or fire events.
    if (matched === 0) {
      return;
    }
    this.hasValidSample = true;

    // libwebrtc: delay detector, acked bitrate, and probe estimator consume
    // feedback in receive-time order (not transport-seq order).
    timedReceived.sort((a, b) => a.recvMs - b.recvMs || a.seq - b.seq);

    this.ackedBitrate.incomingPacketFeedbackVector(
      timedReceived.map((p) => ({
        receiveTimeMs: p.recvMs,
        sendTimeMs: p.sendMs,
        sizeBytes: p.size,
      })),
    );

    for (const p of timedReceived) {
      // Result validation only (sender clock for session complete/cooldown).
      // FIFO pacing advance happens on send-fill, not on ACK.
      this.probe.onAckedPacket(
        p.size,
        p.recvMs,
        p.isProbation,
        p.seq,
        nowMs,
        p.sendMs,
      );
      this.pushInterArrival(p.sendMs, p.recvMs, p.size);
    }

    const known = received + lost;
    const lossFraction = known > 0 ? lost / known : 0;
    const ackedBps = this.ackedBitrate.bitrate();

    // Capture previous usage *before* updating — recovery probe is gated on
    // underuse → normal (libwebrtc recovered_from_overuse), not on lingering
    // underuse while the queue is still draining.
    const previousUsage = this.lastUsage;
    const usage = this.trendline.state;
    if (usage !== this.lastUsage) {
      this.lastUsage = usage;
      this.onOveruseDetected.execute(usage);
    }

    // Probe gating is split (libwebrtc GetBandwidthLimitedCause / ProbeController):
    // - Upward probe *results* apply unless delay path is overusing.
    // - *New* recovery/further clusters use full cause mapping (not a single
    //   congested bit): underuse/overuse / high RTT / loss decreasing|hold
    //   forbid; loss increasing allows with scale cap; delay_based uncapped.
    // Active clusters keep pacing until send-fill or pacing timeout (libwebrtc
    // does not mid-abort BitrateProber clusters on TWCC batch loss).
    const allowUpwardProbeResult = usage !== "overuse";

    const batchFirstSend = Number.isFinite(firstSend) ? firstSend : 0;
    const batchLastSend = lastSend > 0 ? lastSend : batchFirstSend;

    // libwebrtc OnTransportPacketsFeedback: max_feedback_rtt =
    //   max over received of (feedback_time − send_time)
    // = feedback_time − earliest send among received packets.
    // Using only last-send RTT would miss a high-RTT head packet when the
    // tail of the same batch is still under the 3s limit.
    // Always refresh lastFeedbackRttMs for any finite proxy (clamp ≥0) so
    // high-RTT → normal recovery and >30s spikes update gating.
    // AIMD TimeToReduceFurther only receives a clamped [10, 2000] ms RTT.
    if (Number.isFinite(earliestReceivedSend)) {
      const rttProxy = nowMs - earliestReceivedSend;
      if (Number.isFinite(rttProxy)) {
        const rttMs = Math.max(0, rttProxy);
        this.lastFeedbackRttMs = rttMs;
        // AIMD: practical clamp only — does not gate IsRttAboveLimit.
        if (rttMs >= 10 && rttMs <= 2000) {
          this.aimd.setRtt(Math.max(kDefaultRttMs, rttMs));
        }
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

    // libwebrtc GetBandwidthLimitedCause → InitiateProbing permission / cap.
    // Cause is evaluated on pre-probe-apply loss state (matches MaybeTrigger
    // ordering: loss estimator update then SetEstimatedBitrate with cause).
    const lossState = this.lossBwe.lossState;
    const rttLimited = isRttAboveLimit(this.lastFeedbackRttMs);
    const bandwidthLimitedCause = getBandwidthLimitedCause(
      usage,
      rttLimited,
      lossState,
    );
    const allowNewProbe = isProbeInitiationAllowed(bandwidthLimitedCause);

    let target = Math.min(this.delayBasedBps, this.lossBasedBps);

    // libwebrtc SendSideBandwidthEstimation::UpdateEstimate RttBasedBackoff:
    // while CorrectedRtt > limit, periodically drop by drop_fraction and do
    // not ramp up between drops (UpdateEstimate returns early after handling).
    if (rttLimited) {
      const floor = Math.max(
        kMinBitrateBps,
        kRttBasedBackOffBandwidthFloorBps,
      );
      const baseline =
        this._availableBitrate > 0 ? this._availableBitrate : target;
      if (
        baseline > floor &&
        nowMs - this.lastRttBackoffDecreaseMs >= kRttBasedBackOffDropIntervalMs
      ) {
        const dropped = Math.max(
          baseline * kRttBasedBackOffDropFraction,
          floor,
        );
        target = dropped;
        this.aimd.setEstimate(dropped, nowMs);
        this.lossBwe.setBandwidthEstimate(dropped);
        this.delayBasedBps = dropped;
        this.lossBasedBps = dropped;
        this.lastRttBackoffDecreaseMs = nowMs;
      } else {
        // Hold: no increase while RTT remains above limit.
        target = Math.min(target, baseline);
        this.delayBasedBps = Math.min(this.delayBasedBps, target);
        this.lossBasedBps = Math.min(this.lossBasedBps, target);
      }
    }

    // Apply valid probe results (libwebrtc GoogCc):
    // - Rise: only when not overusing; soft caps by initial vs recovery phase.
    // - Fall: always apply with acked×0.85 floor — same feedback may show loss
    //   while ProbeBitrateEstimator still has a valid lower result (80% ACKed).
    // Do not discard lower results solely because delay is overusing.
    const probeBps = this.probe.takePendingEstimateBps();
    if (probeBps > 0) {
      const initialProbing = !this.initialExponentialDone;
      let accepted = Math.min(probeBps, kMaxBitrateBps);
      let apply = false;

      if (accepted > target) {
        if (allowUpwardProbeResult) {
          if (initialProbing) {
            if (ackedBps > kMinBitrateBps) {
              accepted = Math.min(
                accepted,
                ackedBps * kProbeResultMaxOverAcked,
              );
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
          apply = accepted > target;
        }
        // overuse + rising: ignore upward probe (padding may still finish)
      } else if (accepted < target) {
        // libwebrtc limit_probes_lower_than_throughput_estimate:
        // probe = max(probe, min(delayEstimate, acked × 0.85)).
        const ackedFloor =
          ackedBps > kMinBitrateBps
            ? ackedBps * kProbeDropThroughputFraction
            : accepted;
        const floor = Math.min(target, ackedFloor);
        accepted = Math.max(accepted, floor);
        accepted = Math.min(accepted, target); // never raise via lower path
        apply = accepted < target && accepted > 0;
      }

      if (apply && accepted > 0) {
        target = accepted;
        // libwebrtc: SetEstimate / SetBandwidthEstimate — preserve controller
        // history (RTT, max-bitrate variance, loss observations, HOLD).
        this.aimd.setEstimate(accepted, nowMs);
        this.lossBwe.setBandwidthEstimate(accepted);
        this.delayBasedBps = accepted;
        this.lossBasedBps = accepted;
      }
      // Further-probe: cause from pre-apply state; max_probe uses the estimate
      // passed into SetEstimatedBitrate (libwebrtc estimated_bitrate_ = bitrate).
      const forFurther = apply && accepted > 0 ? accepted : target;
      if (forFurther > 0 && allowNewProbe) {
        const maxProbe = maxProbeBitrateBps(
          bandwidthLimitedCause,
          forFurther,
          kMaxBitrateBps,
        );
        for (const cfg of this.probe.setEstimatedBitrate(forFurther, nowMs, {
          maxProbeBps: maxProbe,
        })) {
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

    // Recovery probe only on underuse → normal (libwebrtc recovered_from_overuse).
    // Do not request probes while still underusing (queue drain in progress).
    // Same cause gate as further (including RTT-high and loss-limited cap).
    const recoveredFromUnderuse =
      previousUsage === "underuse" && usage === "normal";
    if (
      recoveredFromUnderuse &&
      this.probe.probeState === "complete" &&
      allowNewProbe
    ) {
      const est = this._availableBitrate > 0 ? this._availableBitrate : target;
      const maxProbe = maxProbeBitrateBps(
        bandwidthLimitedCause,
        est,
        kMaxBitrateBps,
      );
      for (const cfg of this.probe.requestProbe(est, nowMs, {
        maxProbeBps: maxProbe,
      })) {
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
    this.softLostSeqs.clear();
    this.lastUsage = "normal";
    this.ackedBitrate.reset();
    this._availableBitrate = 0;
    this.delayBasedBps = this.startBitrateBps;
    this.lossBasedBps = this.startBitrateBps;
    this.probingConfigured = false;
    this.initialExponentialDone = false;
    this.hasValidSample = false;
    this.probeClusterSentBytes = 0;
    this.probeClusterStartMs = 0;
    this.lastProbeTargetBps = 0;
    this.lastFeedbackRttMs = kDefaultRttMs;
    this.lastRttBackoffDecreaseMs = Number.NEGATIVE_INFINITY;
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
        this.softLostSeqs.delete(seq);
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
        this.softLostSeqs.delete(seq);
      }
    }
    if (this.finalizedSeqs.size > 8192) {
      this.finalizedSeqs.clear();
    }
  }

  private pushInterArrival(sendMs: number, recvMs: number, size: number) {
    const deltas = this.interArrival.computeDeltas(sendMs, recvMs, size);
    if (deltas) {
      this.trendline.update(deltas.recvDeltaMs, deltas.sendDeltaMs, recvMs);
    }
  }
}

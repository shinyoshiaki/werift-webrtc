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
  kSentInfoMaxAgeMs,
  kStreamTimeOutMs,
} from "./constants";
import { InterArrivalDelta } from "./interArrivalDelta";
import { LossBasedBwe, type LossPacketFeedback } from "./lossBasedBwe";
import type { BandwidthUsage } from "./overuseDetector";
import type { ProbeClusterConfig, ProbeState } from "./probeController";
import { ProbeController } from "./probeController";
import {
  computeFeedbackRttStats,
  RttBasedBackoff,
} from "./rttBasedBackoff";
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
   * libwebrtc RttBasedBackoff — IsRttAboveLimit uses **propagation RTT**
   * (CorrectedRtt), not raw max feedback RTT. max feedback RTT is stored only
   * for diagnostics (congestion-window style uses in pin).
   */
  private readonly rttBackoff = new RttBasedBackoff();
  /** Last batch max_feedback_rtt (diagnostics; not used for probe cause). */
  private lastMaxFeedbackRttMs = 0;
  /** Last batch min_propagation_rtt (before timeout correction). */
  private lastPropagationRttMs = 0;
  /**
   * Sender clock of the last TWCC packet feedback that fed the delay path
   * (libwebrtc DelayBasedBwe::last_seen_packet_).
   */
  private lastSeenPacketMs = Number.NEGATIVE_INFINITY;

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
    this.rttBackoff.onSentPacket(info.sendingAtMs);
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

    // libwebrtc DelayBasedBwe::kStreamTimeOut — idle > 2s resets delay path
    // so stale trendline history does not produce false overuse/underuse.
    if (
      timedReceived.length > 0 &&
      Number.isFinite(this.lastSeenPacketMs) &&
      nowMs - this.lastSeenPacketMs > kStreamTimeOutMs
    ) {
      this.interArrival.reset();
      this.trendline.reset();
      this.lastUsage = "normal";
    }
    if (timedReceived.length > 0) {
      this.lastSeenPacketMs = nowMs;
    }

    // libwebrtc DelayBasedBwe::IncomingPacketFeedbackVector — latch
    // recovered_from_overuse on **per-packet** underuse→normal transitions
    // inside this feedback (not only feedback-to-feedback lastUsage).
    let recoveredFromUnderuse = false;
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
      const prevUsage = this.trendline.state;
      this.pushInterArrival(p.sendMs, p.recvMs, p.size);
      const nextUsage = this.trendline.state;
      if (prevUsage === "underuse" && nextUsage === "normal") {
        recoveredFromUnderuse = true;
      }
    }

    const known = received + lost;
    const lossFraction = known > 0 ? lost / known : 0;
    const ackedBps = this.ackedBitrate.bitrate();

    const usage = this.trendline.state;
    if (usage !== this.lastUsage) {
      this.lastUsage = usage;
      this.onOveruseDetected.execute(usage);
    }

    // pin DelayBasedBwe::MaybeUpdateEstimate:
    // - overusing → ignore probe_bitrate entirely (AIMD decrease only)
    // - else if probe_bitrate → SetEstimate(probe); recovered_from_overuse=false
    // - else → UpdateEstimate; may surface recovered_from_overuse
    // Active clusters keep pacing until send-fill or pacing timeout.
    const overusing = usage === "overuse";

    const batchFirstSend = Number.isFinite(firstSend) ? firstSend : 0;
    const batchLastSend = lastSend > 0 ? lastSend : batchFirstSend;

    // libwebrtc OnTransportPacketsFeedback RTT split:
    //   max_feedback_rtt  → feedback_max_rtts_ (CWND; not probe cause)
    //   min_propagation_rtt → UpdatePropagationRtt → IsRttAboveLimit
    const rttStats = computeFeedbackRttStats(
      timedReceived.map((p) => ({ sendMs: p.sendMs, recvMs: p.recvMs })),
      nowMs,
    );
    if (rttStats) {
      this.lastMaxFeedbackRttMs = rttStats.maxFeedbackRttMs;
      this.lastPropagationRttMs = rttStats.minPropagationRttMs;
      this.rttBackoff.updatePropagationRtt(
        nowMs,
        rttStats.minPropagationRttMs,
      );
      // AIMD TimeToReduceFurther: practical clamp on corrected/propagation RTT.
      const aimdRtt = this.rttBackoff.correctedRttMs();
      if (aimdRtt >= 10 && aimdRtt <= 2000) {
        this.aimd.setRtt(Math.max(kDefaultRttMs, aimdRtt));
      }
    }

    // --- Pin order (goog_cc_network_control OnTransportPacketsFeedback) ---
    // 1) Delay path (AIMD) with optional probe SetEstimate
    // 2) LossBased estimator with post-probe delay estimate as input
    // 3) GetBandwidthLimitedCause / target from **post-loss** state
    //
    // Consume pending probe before deciding recovery (pin FetchAndReset before
    // MaybeUpdateEstimate — any probe estimate suppresses recovered_from_overuse).
    const probeBps = this.probe.takePendingEstimateBps();
    const hasProbeEstimate = probeBps > 0;

    if (overusing) {
      // pin: overuse branch never applies probe_bitrate.
      this.delayBasedBps = this.aimd.update(usage, ackedBps, nowMs);
    } else if (hasProbeEstimate) {
      // pin: SetEstimate(probe) only — no UpdateEstimate this feedback.
      // limit_probes_lower_than_throughput_estimate floors a low probe so we
      // do not drop far below measured throughput (drain queues slightly).
      const initialProbing = !this.initialExponentialDone;
      let accepted = Math.min(probeBps, kMaxBitrateBps);
      let apply = false;
      const delayTarget =
        this.delayBasedBps > 0 ? this.delayBasedBps : this.aimd.targetBitrateBps;

      if (accepted > delayTarget) {
        if (initialProbing) {
          if (ackedBps > kMinBitrateBps) {
            accepted = Math.min(accepted, ackedBps * kProbeResultMaxOverAcked);
          }
        } else {
          // Recovery: min(probe, max(delay×1.5, acked×2)).
          const targetCap = delayTarget * kProbeResultMaxOverTarget;
          const ackedCap =
            ackedBps > kMinBitrateBps
              ? ackedBps * kProbeResultMaxOverAcked
              : targetCap;
          accepted = Math.min(accepted, Math.max(targetCap, ackedCap));
        }
        // Werift recovery/initial caps may clip a rising probe; do not apply a
        // "upward" result that no longer exceeds the current delay target.
        apply = accepted > delayTarget;
      } else if (accepted < delayTarget) {
        // libwebrtc limit_probes_lower_than_throughput_estimate:
        // probe = max(probe, min(delayEstimate, acked × 0.85)).
        const ackedFloor =
          ackedBps > kMinBitrateBps
            ? ackedBps * kProbeDropThroughputFraction
            : accepted;
        const floor = Math.min(delayTarget, ackedFloor);
        accepted = Math.max(accepted, floor);
        accepted = Math.min(accepted, delayTarget); // never raise via lower path
        apply = accepted < delayTarget && accepted > 0;
      } else {
        // Equal to delay target — SetEstimate is a no-op but keeps pin order.
        apply = accepted > 0;
      }

      if (apply && accepted > 0) {
        this.aimd.setEstimate(accepted, nowMs);
        this.delayBasedBps = accepted;
      } else {
        // Probe present but not applied (caps): keep prior delay estimate.
        // Do not run AIMD UpdateEstimate this feedback (pin probe branch).
        this.delayBasedBps = this.aimd.targetBitrateBps;
      }
    } else {
      this.delayBasedBps = this.aimd.update(usage, ackedBps, nowMs);
    }

    // Loss path after delay/probe (pin UpdateLossBasedEstimator).
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

    // Final target = loss-based result (already min'd vs delay inside LossBasedBwe).
    // Keep explicit min as a safety belt for cold-start / stub paths.
    const target = Math.min(this.delayBasedBps, this.lossBasedBps);

    // Post-loss GetBandwidthLimitedCause (pin MaybeTriggerOnNetworkChanged).
    // High RTT only gates new probes (×0.8 target drop not applied in werift).
    const rttLimited = this.rttBackoff.isRttAboveLimit();
    const bandwidthLimitedCause = getBandwidthLimitedCause(
      usage,
      rttLimited,
      this.lossBwe.lossState,
    );
    const allowNewProbe = isProbeInitiationAllowed(bandwidthLimitedCause);

    if (this.probe.probeState === "complete") {
      this.initialExponentialDone = true;
    }

    if (target > 0 && this.hasValidSample) {
      setAvailableBitrateIfChanged(this, target);
    }

    // libwebrtc MaybeTriggerOnNetworkChanged → SetEstimatedBitrate on every
    // target update (not only when a probe result is pending). Further clusters
    // open only while ProbeController is still waiting_for_result; complete
    // clears min_bitrate_to_probe_further so this call is a no-op after session end.
    // maxProbeBps=0 when cause forbids InitiateProbing (still updates estimated).
    if (target > 0) {
      const maxProbe = allowNewProbe
        ? maxProbeBitrateBps(bandwidthLimitedCause, target, kMaxBitrateBps)
        : 0;
      for (const cfg of this.probe.setEstimatedBitrate(target, nowMs, {
        maxProbeBps: maxProbe,
      })) {
        this.onProbeClusterActivated(cfg, nowMs);
      }
    }

    // Recovery probe only on latched underuse→normal (recovered_from_overuse).
    // pin MaybeUpdateEstimate: recovered_from_overuse is surfaced only when
    // not overusing and no probe_bitrate was present this feedback.
    // Same post-loss cause gate as further (including RTT-high and loss-limited).
    if (
      recoveredFromUnderuse &&
      !overusing &&
      !hasProbeEstimate &&
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
    this.rttBackoff.reset();
    this.lastMaxFeedbackRttMs = 0;
    this.lastPropagationRttMs = 0;
    this.lastSeenPacketMs = Number.NEGATIVE_INFINITY;
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
   *
   * finalized/soft-lost sets are pruned to keys still present in sentInfos
   * (never wholesale-cleared while live seqs remain — that would re-count
   * received packets in LossBased partial observations).
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
    if (this.sentInfos.size > keepWindow) {
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
    }
    // Drop orphan finalize/soft-loss markers no longer backed by sentInfos.
    if (this.finalizedSeqs.size > this.sentInfos.size) {
      for (const seq of this.finalizedSeqs) {
        if (!this.sentInfos.has(seq)) this.finalizedSeqs.delete(seq);
      }
    }
    if (this.softLostSeqs.size > this.sentInfos.size) {
      for (const seq of this.softLostSeqs) {
        if (!this.sentInfos.has(seq)) this.softLostSeqs.delete(seq);
      }
    }
  }

  private pushInterArrival(sendMs: number, recvMs: number, size: number) {
    const deltas = this.interArrival.computeDeltas(sendMs, recvMs, size);
    if (deltas) {
      this.trendline.update(deltas.recvDeltaMs, deltas.sendDeltaMs, recvMs);
    }
  }
}

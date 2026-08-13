import { Event } from "../../../../imports/common";
import type { TransportWideCC } from "../../../../imports/rtp";
import { milliTime } from "../../../../utils";
import type {
  BandwidthEstimator,
  BandwidthEstimatorProcessor,
  ProbePacingController,
  RoundTripTimeConsumer,
  SentInfo,
} from "../../bandwidthEstimator";
import { setAvailableBitrateIfChanged } from "../../bandwidthEstimator";
import { hasTwccReceiveTiming } from "../twccReceiveTiming";
import { TwccReferenceTimeUnwrapper } from "../twccReferenceTime";
import { AcknowledgedBitrateEstimator } from "./acknowledgedBitrateEstimator";
import { AimdRateControl } from "./aimdRateControl";
import { AlrDetector } from "./alrDetector";
import {
  type BandwidthLimitedCause,
  getBandwidthLimitedCause,
  isProbeInitiationAllowed,
  maxProbeBitrateBps,
} from "./bandwidthLimitedCause";
import {
  GCC_KNOWN_DIFFERENCES,
  kDefaultMaxProbingBitrateBps,
  kDefaultStartBitrateBps,
  kMaxBitrateBps,
  kMinBitrateBps,
  kProbeDropThroughputFraction,
  kProbePaddingPacketBytes,
  kRttBasedBackOffBandwidthFloorBps,
  kRttBasedBackOffDropFraction,
  kRttBasedBackOffDropIntervalMs,
  kSendTimeHistoryWindowMs,
  kStreamTimeOutMs,
} from "./constants";
import { InterArrivalDelta } from "./interArrivalDelta";
import { LossBasedBwe, type LossPacketFeedback } from "./lossBasedBwe";
import type { BandwidthUsage } from "./overuseDetector";
import type { ProbeClusterConfig, ProbeState } from "./probeController";
import { ProbeController } from "./probeController";
import { RttBasedBackoff, computeFeedbackRttStats } from "./rttBasedBackoff";
import {
  TWCC_SEQ_MOD,
  TransportWideSeqUnwrapper,
  sortPacketResultsByWideSeq,
} from "./sequenceNumber";
import { TrendlineEstimator } from "./trendlineEstimator";

/**
 * Optional sender clock for tests. Production uses {@link milliTime} so
 * `sendingAtMs` and TWCC feedback arrival share one domain (pin Timestamp).
 */
export type GccClock = () => number;

/**
 * Optional GCC constructor settings. Probe / RTT inputs stay off the thin
 * {@link BandwidthEstimator} interface (capability + constructor, not common I/O).
 */
export type GccBandwidthEstimatorOptions = {
  /**
   * Sender clock. Tests may inject a synthetic clock so send / feedback stay
   * in one domain. Production omits this (defaults to {@link milliTime}).
   */
  clock?: GccClock;
  /**
   * pin `requests_alr_probing` / `ProbeController::EnablePeriodicAlrProbing`.
   * Default **false** — GoogCc does not enable periodic ALR probing after the
   * first TWCC; only an explicit config / this option turns it on.
   */
  periodicAlrProbing?: boolean;
};

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
  implements
    BandwidthEstimator,
    ProbePacingController,
    RoundTripTimeConsumer,
    BandwidthEstimatorProcessor
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
  /** pin `AlrDetector` — send vs estimate budget. */
  private readonly alr = new AlrDetector();
  private previouslyInAlr = false;
  /** After dispose(), public I/O is a no-op so a leftover padding loop cannot revive state. */
  private disposed = false;
  private readonly interArrival = new InterArrivalDelta();
  /** Unwraps 24-bit TWCC reference_time across feedbacks. */
  private readonly refTimeUnwrapper = new TwccReferenceTimeUnwrapper();
  /**
   * Sender clock. Production: {@link milliTime}. Tests may inject a synthetic
   * clock so send / feedback stay in one domain (no production clock heuristic).
   */
  private readonly clock: GccClock;

  /**
   * Sent-packet history keyed by **unwrapped** transport-wide sequence
   * (pin TransportFeedbackAdapter `history_`). 16-bit wire seq alone would
   * overwrite the previous generation after wrap.
   */
  private sentInfos = new Map<number, SentInfo>();
  /** pin `RtpSequenceNumberUnwrapper` shared by send and feedback lookup. */
  private readonly seqUnwrapper = new TransportWideSeqUnwrapper();
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
   * When above limit, pin UpdateEstimate applies ×0.8 target drops.
   */
  private readonly rttBackoff = new RttBasedBackoff();
  /**
   * pin `SendSideBandwidthEstimation::current_target_` — final target layer
   * that RTT backoff multiplies. Initialized to start bitrate (constraints).
   */
  private currentTargetBps: number;
  /**
   * pin `time_last_decrease_` for RTT-based target drops
   * (MinusInfinity so the first drop fires immediately when above limit).
   */
  private lastRttDecreaseMs = Number.NEGATIVE_INFINITY;
  /** pin `first_packet_sent_` — seeds UpdatePropagationRtt(send, 0). */
  private firstPacketSent = false;
  /** Last batch max_feedback_rtt (diagnostics; not used for probe cause). */
  private lastMaxFeedbackRttMs = 0;
  /** Last batch min_propagation_rtt (before timeout correction). */
  private lastPropagationRttMs = 0;
  /**
   * Sender clock of the last TWCC packet feedback that fed the delay path
   * (libwebrtc DelayBasedBwe::last_seen_packet_).
   */
  private lastSeenPacketMs = Number.NEGATIVE_INFINITY;
  /**
   * pin `enable_periodic_alr_probing_` — persisted across {@link reset}
   * (constructor / {@link enablePeriodicAlrProbing}).
   */
  private periodicAlrProbing = false;

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
    if (this.disposed) return false;
    this.ensureProbing(this.clock());
    return this.probe.shouldTagProbePacket();
  }

  /**
   * How many padding packets the sender should inject to progress the active
   * probe cluster when media is sparse. 0 if not probing or cluster is full.
   */
  pendingProbePaddingPackets(packetBytes = kProbePaddingPacketBytes): number {
    if (this.disposed) return 0;
    this.ensureProbing(this.clock());
    if (!this.probe.shouldTagProbePacket()) return 0;
    const remaining = this.probe.remainingProbeBytes(packetBytes);
    if (remaining <= 0) return 0;
    return Math.ceil(remaining / Math.max(1, packetBytes));
  }

  /**
   * pin GoogCcNetworkController::OnProcessInterval order:
   *   UpdateEstimate
   *   → SetAlrStartTime
   *   → ProbeController::Process
   *   → MaybeTriggerOnNetworkChanged
   *
   * Process still sees the **previous** BandwidthLimitedCause. A tick that
   * first crosses the RTT limit can therefore emit a due ALR probe, and only
   * afterwards publish `kRttBasedBackOffHighRtt`. Does **not** call
   * {@link RttBasedBackoff.onSentPacket}.
   */
  process(nowMs: number): void {
    if (this.disposed || !Number.isFinite(nowMs)) return;
    // Age-out send history even when media is idle (pin 60s window).
    // rtpPacketSent-only prune would leak after send stop.
    this.pruneSentInfos(nowMs);
    // 1) bandwidth_estimation_.UpdateEstimate
    this.maybeApplyRttBasedBackoff(nowMs);
    // 2) ProbeController::SetAlrStartTime
    this.syncAlr(nowMs);
    // 3) ProbeController::Process (still previous cause)
    for (const cfg of this.probe.process(nowMs)) {
      this.onProbeClusterActivated(cfg, nowMs);
    }
    // 4) MaybeTriggerOnNetworkChanged — ALR budget + estimated/cause
    this.propagateTarget(nowMs);
  }

  /**
   * pin `EnablePeriodicAlrProbing` / later `OnStreamsConfig`.
   * Default remains false until the caller opts in.
   */
  enablePeriodicAlrProbing(enable: boolean): void {
    this.periodicAlrProbing = enable;
    this.probe.enablePeriodicAlrProbing(enable);
  }

  /**
   * pin `OnNetworkStateEstimate` / `SetNetworkStateEstimate`.
   * `linkCapacityUpperBps <= 0` clears the estimate.
   */
  setNetworkStateEstimate(linkCapacityUpperBps: number): void {
    if (this.disposed) return;
    this.probe.setNetworkStateEstimate(linkCapacityUpperBps);
  }

  /**
   * pin OnRoundTripTimeUpdate → DelayBasedBwe::OnRttUpdate → AimdRateControl::SetRtt.
   * Callers must pass **raw** (unsmoothed) RTCP RR RTT in milliseconds — pin
   * GoogCc discards smoothed RTT updates. Independent of TWCC propagation RTT
   * used by {@link RttBasedBackoff}.
   */
  setRoundTripTime(rttMs: number): void {
    this.aimd.setRtt(rttMs);
  }

  static readonly knownDifferences = GCC_KNOWN_DIFFERENCES;

  /**
   * @param startBitrateBps Initial target / AIMD start (bps).
   * @param options.clock Optional sender clock for unit tests. Must match the
   *   domain of {@link SentInfo.sendingAtMs} used with this instance.
   *   Production omits this (defaults to {@link milliTime}).
   * @param options.periodicAlrProbing pin `requests_alr_probing` (default false).
   */
  constructor(
    startBitrateBps = kDefaultStartBitrateBps,
    options?: GccBandwidthEstimatorOptions,
  ) {
    this.startBitrateBps = startBitrateBps;
    this.currentTargetBps = startBitrateBps;
    this.clock = options?.clock ?? milliTime;
    this.aimd.reset(startBitrateBps);
    this.lossBwe.reset(startBitrateBps);
    this.delayBasedBps = startBitrateBps;
    this.lossBasedBps = startBitrateBps;
    this.enablePeriodicAlrProbing(options?.periodicAlrProbing === true);
  }

  rtpPacketSent(info: SentInfo) {
    if (this.disposed) return;
    this.alr.onBytesSent(info.size, info.sendingAtMs);
    this.ackedBitrate.setAlr(this.alr.inAlr);
    this.aimd.setInApplicationLimitedRegion(this.alr.inAlr);
    this.pruneSentInfos(info.sendingAtMs);
    const seq = this.seqUnwrapper.unwrap(info.wideSeq);
    this.sentInfos.set(seq, info);
    // Re-sending the same extended seq (true retransmit of that generation)
    // clears prior finalize. A wrap creates a *new* key and leaves the old
    // generation intact.
    this.finalizedSeqs.delete(seq);
    this.softLostSeqs.delete(seq);
    // pin GoogCcNetworkController::OnSentPacket — first packet seeds
    // UpdatePropagationRtt(send_time, 0) so CorrectedRtt grows while
    // packets are sent without feedback (ProcessInterval / sender clock).
    if (!this.firstPacketSent) {
      this.firstPacketSent = true;
      this.rttBackoff.updatePropagationRtt(info.sendingAtMs, 0);
    }
    this.rttBackoff.onSentPacket(info.sendingAtMs);
    // pin OnSentPacket does **not** call UpdateEstimate or ProbeController::Process.
    // Those run on the 25ms ProcessInterval ({@link process}).
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
  }

  receiveTWCC(feedback: TransportWideCC) {
    if (this.disposed) return;
    // pin feedback_time is sender-local Timestamp (same domain as send times).
    // No wall/receive-timeline heuristic — tests inject {@link GccClock} when
    // using synthetic send timelines.
    const nowMs = this.clock();
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
      const seq = this.resolveFeedbackSeq(
        result.sequenceNumber,
        result.received,
      );
      if (seq === undefined) {
        // Unknown sequence (swap / late feedback) — do not count as loss.
        continue;
      }
      const info = this.sentInfos.get(seq);
      if (!info) {
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
    //   min_propagation_rtt → UpdatePropagationRtt → IsRttAboveLimit + target drop
    // AIMD RTT is a separate path (OnRoundTripTimeUpdate / RTCP RR via
    // {@link setRoundTripTime}) — never copy propagation RTT into AIMD.
    // feedback_time = sender clock now (pin report.feedback_time domain).
    const rttPackets = timedReceived.map((p) => ({
      sendMs: p.sendMs,
      recvMs: p.recvMs,
    }));
    const rttStats = computeFeedbackRttStats(rttPackets, nowMs);
    if (rttStats) {
      this.lastMaxFeedbackRttMs = rttStats.maxFeedbackRttMs;
      this.lastPropagationRttMs = rttStats.minPropagationRttMs;
      this.rttBackoff.updatePropagationRtt(nowMs, rttStats.minPropagationRttMs);
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
      // pin MaybeUpdateEstimate (non-overuse + probe_bitrate):
      // SetEstimate(probe) as-is — **no upward caps**. Only lower probes get
      // limit_probes_lower_than_throughput_estimate:
      //   probe = max(probe, min(delayEstimate, acked × 0.85)).
      let accepted = Math.min(probeBps, kMaxBitrateBps);
      const delayTarget =
        this.delayBasedBps > 0
          ? this.delayBasedBps
          : this.aimd.targetBitrateBps;

      if (accepted < delayTarget) {
        const ackedFloor =
          ackedBps > kMinBitrateBps
            ? ackedBps * kProbeDropThroughputFraction
            : accepted;
        const floor = Math.min(delayTarget, ackedFloor);
        accepted = Math.max(accepted, floor);
        accepted = Math.min(accepted, delayTarget);
      }

      if (accepted > 0) {
        this.aimd.setEstimate(accepted, nowMs);
        this.delayBasedBps = this.aimd.targetBitrateBps;
      } else {
        this.delayBasedBps = this.aimd.targetBitrateBps;
      }
    } else {
      this.delayBasedBps = this.aimd.update(usage, ackedBps, nowMs);
    }

    // Loss path after delay/probe (pin UpdateLossBasedEstimator).
    // Always update LossBasedBwe state, but when RTT-limited pin UpdateEstimate
    // never adopts the loss result as current_target_ (RTT branch returns
    // before LossBasedBandwidthEstimatorV2ReadyForUse).
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

    // Final delay/loss candidate (loss already min'd vs delay inside LossBasedBwe).
    const delayLossTarget = Math.min(this.delayBasedBps, this.lossBasedBps);

    // pin UpdateEstimate RTT branch vs normal:
    // - When RTT-limited: **do not** apply LossBasedBwe result to target.
    //   Drop first (if due), then ApplyTargetLimits / GetUpperLimit
    //   (delay_based + configured max, then min_bitrate). Never clamp-then-drop.
    //   Exception: probe SetSendBitrate already raised current before
    //   UpdateEstimate (delay path holds post-probe estimate).
    // - When not RTT-limited: current_target = post-loss estimate.
    const rttLimited = this.rttBackoff.isRttAboveLimit();
    if (rttLimited) {
      if (hasProbeEstimate && !overusing && this.delayBasedBps > 0) {
        // pin SetSendBitrate(probe) → current_target = probe estimate, then
        // UpdateEstimate may immediately ×0.8 if still above RTT limit.
        this.currentTargetBps = this.delayBasedBps;
      }
      this.maybeApplyRttBasedBackoff(nowMs);
    } else if (delayLossTarget > 0) {
      this.currentTargetBps = delayLossTarget;
    }

    const target = this.currentTargetBps;

    // TWCC and ProcessInterval share MaybeTriggerOnNetworkChanged:
    // publish target, ALR budget, ProbeController estimated + cause.
    const bandwidthLimitedCause = this.propagateTarget(nowMs);
    const allowNewProbe = bandwidthLimitedCause
      ? isProbeInitiationAllowed(bandwidthLimitedCause)
      : false;
    this.syncAlr(nowMs);

    // Recovery probe only on latched underuse→normal (recovered_from_overuse).
    // pin MaybeUpdateEstimate: recovered_from_overuse is surfaced only when
    // not overusing and no probe_bitrate was present this feedback.
    // Same post-loss cause gate as further (including RTT-high and loss-limited).
    if (
      recoveredFromUnderuse &&
      !overusing &&
      !hasProbeEstimate &&
      this.probe.probeState === "complete" &&
      allowNewProbe &&
      bandwidthLimitedCause
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
    this.disposed = false;
    this.trendline.reset();
    this.aimd.reset(this.startBitrateBps);
    this.lossBwe.reset(this.startBitrateBps);
    this.probe.reset();
    this.interArrival.reset();
    this.refTimeUnwrapper.reset();
    this.sentInfos.clear();
    this.finalizedSeqs.clear();
    this.softLostSeqs.clear();
    this.seqUnwrapper.reset();
    this.lastUsage = "normal";
    this.ackedBitrate.reset();
    this._availableBitrate = 0;
    this.delayBasedBps = this.startBitrateBps;
    this.lossBasedBps = this.startBitrateBps;
    this.currentTargetBps = this.startBitrateBps;
    this.lastRttDecreaseMs = Number.NEGATIVE_INFINITY;
    this.firstPacketSent = false;
    this.probingConfigured = false;
    this.hasValidSample = false;
    this.probeClusterSentBytes = 0;
    this.probeClusterStartMs = 0;
    this.lastProbeTargetBps = 0;
    this.rttBackoff.reset();
    this.lastMaxFeedbackRttMs = 0;
    this.lastPropagationRttMs = 0;
    this.lastSeenPacketMs = Number.NEGATIVE_INFINITY;
    this.alr.reset();
    this.previouslyInAlr = false;
    // ProbeController.reset() clears the flag; restore the caller config.
    this.probe.enablePeriodicAlrProbing(this.periodicAlrProbing);
  }

  /**
   * pin `GetUpperLimit` + `UpdateTargetBitrate` min clamp.
   * delay_based_limit_ is +∞ until a delay sample exists (`hasValidSample`).
   */
  private delayBasedUpperLimitBps(): number {
    if (!this.hasValidSample || this.delayBasedBps <= 0) {
      return kMaxBitrateBps;
    }
    return this.delayBasedBps;
  }

  private applyTargetLimits(): void {
    if (this.currentTargetBps <= 0) {
      this.currentTargetBps = this.startBitrateBps;
    }
    const upper = Math.min(this.delayBasedUpperLimitBps(), kMaxBitrateBps);
    this.currentTargetBps = Math.min(this.currentTargetBps, upper);
    this.currentTargetBps = Math.max(this.currentTargetBps, kMinBitrateBps);
  }

  /**
   * pin `SendSideBandwidthEstimation::UpdateEstimate` RTT branch:
   * drop first (if interval due), then ApplyTargetLimits (delay upper + min).
   *
   * Called from {@link process} (pin OnProcessInterval) and after TWCC when
   * still RTT-limited. **Not** from `rtpPacketSent` (pin OnSentPacket).
   * Returns true when a drop was applied.
   */
  private maybeApplyRttBasedBackoff(nowMs: number): boolean {
    if (!Number.isFinite(nowMs)) return false;
    if (!this.rttBackoff.isRttAboveLimit()) return false;
    if (this.currentTargetBps <= 0) {
      this.currentTargetBps = this.startBitrateBps;
    }
    let dropped = false;
    if (
      nowMs - this.lastRttDecreaseMs >= kRttBasedBackOffDropIntervalMs &&
      this.currentTargetBps > kRttBasedBackOffBandwidthFloorBps
    ) {
      this.lastRttDecreaseMs = nowMs;
      this.currentTargetBps = Math.max(
        this.currentTargetBps * kRttBasedBackOffDropFraction,
        kRttBasedBackOffBandwidthFloorBps,
      );
      dropped = true;
    }
    this.applyTargetLimits();
    // Safety drop publishes even before first TWCC (pin ProcessInterval path).
    setAvailableBitrateIfChanged(this, this.currentTargetBps);
    return dropped;
  }

  dispose() {
    this.onAvailableBitrate.allUnsubscribe();
    this.onOveruseDetected.allUnsubscribe();
    this.onProbeClusterConfig.allUnsubscribe();
    this.reset();
    this.disposed = true;
  }

  /**
   * pin MaybeTriggerOnNetworkChanged — publish target, ALR budget, and
   * ProbeController estimated bitrate + BandwidthLimitedCause.
   * On {@link process} this runs **after** ProbeController::Process so the
   * same tick still uses the previous cause (pin order).
   */
  private propagateTarget(nowMs: number): BandwidthLimitedCause | undefined {
    const target = this.currentTargetBps;
    if (!(target > 0)) return undefined;
    // Do not publish the constructor start rate on ProcessInterval before
    // the first TWCC. RTT safety drops already publish via maybeApplyRttBasedBackoff.
    if (this.hasValidSample || this._availableBitrate > 0) {
      setAvailableBitrateIfChanged(this, target);
    }
    this.alr.setEstimatedBitrate(target);
    const cause = getBandwidthLimitedCause(
      this.trendline.state,
      this.rttBackoff.isRttAboveLimit(),
      this.lossBwe.lossState,
    );
    const maxProbe = isProbeInitiationAllowed(cause)
      ? maxProbeBitrateBps(cause, target, kMaxBitrateBps)
      : 0;
    for (const cfg of this.probe.setEstimatedBitrate(target, nowMs, {
      cause,
      maxProbeBps: maxProbe,
    })) {
      this.onProbeClusterActivated(cfg, nowMs);
    }
    return cause;
  }

  /**
   * pin OnProcessInterval / OnTransportPacketsFeedback ALR wiring:
   * publish ALR start/end to ProbeController + AIMD.
   * Does **not** enable periodic ALR probing (pin default false).
   */
  private syncAlr(nowMs: number) {
    const inAlr = this.hasValidSample && this.alr.inAlr;
    this.probe.setAlrStartTime(
      this.hasValidSample ? this.alr.startMs : undefined,
    );
    if (this.previouslyInAlr && !inAlr) {
      this.probe.setAlrEndedTime(nowMs);
      this.ackedBitrate.setAlrEndedTime(nowMs);
    }
    this.previouslyInAlr = inAlr;
    this.aimd.setInApplicationLimitedRegion(inAlr);
    this.ackedBitrate.setAlr(inAlr);
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
      kDefaultMaxProbingBitrateBps,
      nowMs,
    )) {
      this.onProbeClusterActivated(cfg, nowMs);
    }
  }

  /**
   * pin `TransportFeedbackAdapter` send-time history: drop entries older than
   * {@link kSendTimeHistoryWindowMs} (60s). Called from `rtpPacketSent` **and**
   * `process()` so idle / send-stop paths still expire history. No extra
   * 2048-sequence cap — high-rate probe padding would otherwise evict
   * late-ACK-able packets too early.
   *
   * Keys are unwrapped (extended) sequences; wrap does not bound the map.
   *
   * finalized/soft-lost sets are pruned to keys still present in sentInfos
   * (never wholesale-cleared while live seqs remain — that would re-count
   * received packets in LossBased partial observations).
   */
  private pruneSentInfos(nowMs: number) {
    for (const [seq, info] of this.sentInfos) {
      if (nowMs - info.sendingAtMs > kSendTimeHistoryWindowMs) {
        this.sentInfos.delete(seq);
        this.finalizedSeqs.delete(seq);
        this.softLostSeqs.delete(seq);
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

  /**
   * Map a 16-bit TWCC feedback sequence onto the unwrapped sentInfos key.
   *
   * Prefers the newest generation that is still open:
   * - received: newest not-yet-finalized (new packet first; late old after
   *   the new generation is finalized)
   * - not-received: newest not-yet-soft-lost; a duplicate on the newest
   *   generation is ignored (does not walk to an older packet)
   *
   * Walks at most a few wrap generations — the 60s send-time window cannot
   * hold more at realistic packet rates.
   */
  private resolveFeedbackSeq(
    seq16: number,
    received: boolean,
  ): number | undefined {
    const latest = this.seqUnwrapper.peek(seq16);
    let key = latest;
    for (let gen = 0; gen < 8 && key >= 0; gen++, key -= TWCC_SEQ_MOD) {
      if (!this.sentInfos.has(key)) continue;
      if (this.finalizedSeqs.has(key)) continue;
      if (!received && this.softLostSeqs.has(key)) {
        // Duplicate not-received for this generation.
        if (gen === 0) return undefined;
        continue;
      }
      return key;
    }
    return undefined;
  }

  private pushInterArrival(sendMs: number, recvMs: number, size: number) {
    const deltas = this.interArrival.computeDeltas(sendMs, recvMs, size);
    if (deltas) {
      this.trendline.update(deltas.recvDeltaMs, deltas.sendDeltaMs, recvMs);
    }
  }
}

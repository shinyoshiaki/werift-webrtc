import {
  kDefaultStartBitrateBps,
  kLossBasedBandwidthBackoffLowerBoundFactor,
  kLossBasedBandwidthPreferenceSmoothingFactor,
  kLossBasedBoundBestCandidate,
  kLossBasedCandidateFactors,
  kLossBasedDelayedIncreaseWindowMs,
  kLossBasedHigherBwBiasFactor,
  kLossBasedHigherLogBwBiasFactor,
  kLossBasedHoldDurationFactor,
  kLossBasedInherentLossLowerBound,
  kLossBasedInherentLossUpperBoundBwBalanceBps,
  kLossBasedInherentLossUpperBoundOffset,
  kLossBasedInitHoldDurationMs,
  kLossBasedInitialInherentLoss,
  kLossBasedInstantUpperBoundBwBalanceBps,
  kLossBasedInstantUpperBoundLossOffset,
  kLossBasedInstantUpperBoundTemporalWeightFactor,
  kLossBasedLossThresholdOfHighBandwidthPreference,
  kLossBasedLowerBoundByAckedRateFactor,
  kLossBasedMaxHoldDurationMs,
  kLossBasedMaxIncreaseFactor,
  kLossBasedMedianSendingRateFactor,
  kLossBasedMinNumObservations,
  kLossBasedNewtonIterations,
  kLossBasedNewtonStepSize,
  kLossBasedNotIncreaseIfInherentLessThanAverage,
  kLossBasedNotUseAckedRateInAlr,
  kLossBasedObservationDurationLowerBoundMs,
  kLossBasedObservationWindow,
  kLossBasedPaddingDurationMs,
  kLossBasedRampupUpperBoundFactor,
  kLossBasedRampupUpperBoundHoldThreshold,
  kLossBasedRampupUpperBoundInHoldFactor,
  kLossBasedSendingRateSmoothingFactor,
  kLossBasedTemporalWeightFactor,
  kLossBasedUseByteLossRate,
  kMaxBitrateBps,
  kMinBitrateBps,
} from "./constants";

/**
 * Loss-based BWE states (libwebrtc `LossBasedState`).
 * There is no `kHold` — HOLD is a timer inside `kDecreasing`
 * (`last_hold_info_`). `increase_using_padding` is used when
 * {@link kLossBasedPaddingDurationMs} > 0 (pin PaddingDuration default 2s).
 */
export type LossBasedState =
  | "increasing"
  | "increase_using_padding"
  | "decreasing"
  | "delay_based";

interface ChannelParameters {
  inherentLoss: number;
  lossLimitedBandwidthBps: number;
}

/** pin `LossBasedBweV2::Result` plus an explicit {@link LossBasedResult.ready}. */
export interface LossBasedResult {
  /** pin `IsReady()` — controller must not adopt the estimate until true. */
  ready: boolean;
  /**
   * Published bandwidth. When `!ready` and delay is unset this is
   * `+Infinity` (pin `DataRate::PlusInfinity`), never the stale
   * uninitialized `current_best_estimate_`.
   */
  bandwidthEstimateBps: number;
  state: LossBasedState;
}

/** Stored `loss_based_result_` (no readiness bit — that is computed). */
interface StoredLossBasedResult {
  bandwidthEstimateBps: number;
  state: LossBasedState;
}

interface Observation {
  numPackets: number;
  numLostPackets: number;
  numReceivedPackets: number;
  /** Total observation size in bytes. */
  size: number;
  /** Lost bytes within the observation. */
  lostSize: number;
  sendingRateBps: number;
  id: number;
}

/** Optional per-packet feedback for soft loss tracking (seq map). */
export interface LossPacketFeedback {
  seq: number;
  size: number;
  received: boolean;
  sendMs: number;
}

/**
 * LossBasedBweV2-aligned controller
 * (`modules/congestion_controller/goog_cc/loss_based_bwe_v2.*`).
 *
 * - Partial observations accumulate until send-timeline duration ≥ 250ms
 * - Soft loss: not-received seqs live in a map and can be unmarked if later
 *   reported as received **before** the observation commits (pin
 *   PushBackObservation). `num_packets` / `size` increase on every feedback
 *   appearance; the lost map is keyed by seq. After commit, a late received
 *   is a new packet.
 * - Byte-loss objective/derivative when `UseByteLossRate` (default true)
 * - High-bandwidth bias adjusted by average loss ratio
 * - Instant upper/lower bounds + delayed-increase window + HOLD rate
 * - `currentBestEstimate` (candidate model) is distinct from
 *   `lossBasedResult` (internal GoogCC result). HOLD clamps only the result.
 * - Published output (GetLossBasedResult) stays delay-based until
 *   `IsReady()` (initialized current_best + min observations).
 */
export class LossBasedBwe {
  /** pin `current_best_estimate_` — next candidate generation basis. */
  private currentBestEstimate: ChannelParameters = {
    inherentLoss: kLossBasedInitialInherentLoss,
    lossLimitedBandwidthBps: kDefaultStartBitrateBps,
  };
  /**
   * pin `IsValid(current_best_estimate_.loss_limited_bandwidth)`.
   * Starts false (C++ MinusInfinity). First committed observation copies
   * `delay_based_estimate_`; {@link setBandwidthEstimate} marks it valid.
   */
  private currentBestInitialized = false;
  /**
   * pin `loss_based_result_` — value returned to GoogCC.
   * Initial state is `kDelayBasedEstimate`.
   */
  private lossBasedResult: StoredLossBasedResult = {
    bandwidthEstimateBps: kDefaultStartBitrateBps,
    state: "delay_based",
  };
  private observations: Observation[] = [];
  private numObservations = 0;
  private acknowledgedBps = 0;
  private delayBasedBps = 0;
  /** pin `min_bitrate_` / `max_bitrate_` from SetMinMaxBitrate. */
  private minBitrateBps = kMinBitrateBps;
  private maxBitrateBps = kMaxBitrateBps;
  private averageReportedLossRatio = 0;
  private cachedInstantUpperBoundBps = kMaxBitrateBps;
  private cachedInstantLowerBoundBps = 0;
  private lastSendTimeMostRecentObservation = Number.NaN;
  private recoveringAfterLossMs = Number.NaN;
  /** pin `bandwidth_limit_in_current_window_` starts as PlusInfinity. */
  private bandwidthLimitInCurrentWindow = Number.POSITIVE_INFINITY;
  private holdUntilMs = Number.NEGATIVE_INFINITY;
  private holdDurationMs = kLossBasedInitHoldDurationMs;
  private holdRateBps = kMaxBitrateBps;
  /**
   * pin PaddingDuration. Default {@link kLossBasedPaddingDurationMs} (2s).
   * Tests may override via {@link setPaddingDurationMs}.
   */
  private paddingDurationMs = kLossBasedPaddingDurationMs;
  private lastPaddingMs = Number.NEGATIVE_INFINITY;
  private lastPaddingRateBps = 0;
  /** Last `in_alr` passed to {@link update} (GetCandidates). */
  private inAlr = false;
  private partial = {
    numPackets: 0,
    /** seq → lost size (soft loss map). */
    lostPackets: new Map<number, number>(),
    size: 0,
  };
  /**
   * Hard cap on partial observation maps. If send-timeline duration never
   * reaches the 250ms lower bound (e.g. stuck clocks), maps stay bounded.
   */
  private static readonly kMaxPartialPackets = 4096;
  private temporalWeights: number[] = [];
  /** pin `instant_upper_bound_temporal_weights_` (average loss ratio). */
  private instantTemporalWeights: number[] = [];

  constructor() {
    this.recomputeTemporalWeights();
  }

  reset(startBps = kDefaultStartBitrateBps) {
    const start = clamp(startBps);
    this.currentBestEstimate = {
      inherentLoss: kLossBasedInitialInherentLoss,
      lossLimitedBandwidthBps: start,
    };
    this.currentBestInitialized = false;
    this.lossBasedResult = {
      bandwidthEstimateBps: start,
      state: "delay_based",
    };
    this.observations = [];
    this.numObservations = 0;
    this.acknowledgedBps = 0;
    this.delayBasedBps = 0;
    this.minBitrateBps = kMinBitrateBps;
    this.maxBitrateBps = kMaxBitrateBps;
    this.averageReportedLossRatio = 0;
    this.cachedInstantUpperBoundBps = kMaxBitrateBps;
    this.cachedInstantLowerBoundBps = 0;
    this.lastSendTimeMostRecentObservation = Number.NaN;
    this.recoveringAfterLossMs = Number.NaN;
    this.bandwidthLimitInCurrentWindow = Number.POSITIVE_INFINITY;
    this.holdUntilMs = Number.NEGATIVE_INFINITY;
    this.holdDurationMs = kLossBasedInitHoldDurationMs;
    this.holdRateBps = kMaxBitrateBps;
    this.paddingDurationMs = kLossBasedPaddingDurationMs;
    this.lastPaddingMs = Number.NEGATIVE_INFINITY;
    this.lastPaddingRateBps = 0;
    this.inAlr = false;
    this.partial = {
      numPackets: 0,
      lostPackets: new Map(),
      size: 0,
    };
    this.recomputeTemporalWeights();
  }

  /**
   * pin PaddingDuration. 0 keeps `increasing`; >0 enters
   * `increase_using_padding` on loss-limited increase (maps to kLossLimitedBwe).
   */
  setPaddingDurationMs(ms: number) {
    this.paddingDurationMs = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  }

  /**
   * pin `LossBasedBweV2::SetMinMaxBitrate`.
   * `maxBps <= 0` / non-finite → {@link kMaxBitrateBps} (1 Gbps).
   */
  setMinMaxBitrate(minBps: number, maxBps: number): void {
    if (Number.isFinite(minBps) && minBps > 0) {
      this.minBitrateBps = Math.max(minBps, kMinBitrateBps);
      this.calculateInstantLowerBound();
    }
    if (Number.isFinite(maxBps) && maxBps > 0) {
      this.maxBitrateBps = Math.max(this.minBitrateBps, maxBps);
    } else {
      this.maxBitrateBps = kMaxBitrateBps;
    }
  }

  /**
   * State-preserving bandwidth update (libwebrtc
   * `LossBasedBweV2::SetBandwidthEstimate`).
   * Sets the loss-limited bandwidth and marks delay-based alignment without
   * clearing observation history, HOLD timers, or inherent-loss estimates.
   */
  setBandwidthEstimate(bandwidthBps: number) {
    const bps = clamp(bandwidthBps);
    this.currentBestEstimate.lossLimitedBandwidthBps = bps;
    this.currentBestInitialized = true;
    this.lossBasedResult = {
      bandwidthEstimateBps: bps,
      state: "delay_based",
    };
  }

  /**
   * pin `LossBasedBweV2::IsReady` — initialized current_best and
   * `num_observations_ >= MinNumObservations`.
   */
  get isReady(): boolean {
    return (
      this.currentBestInitialized &&
      this.numObservations >= kLossBasedMinNumObservations
    );
  }

  /**
   * pin `GetLossBasedResult`. Until {@link isReady}, delay (or `+Infinity`
   * if delay is unset) with `kDelayBasedEstimate`. Does **not** expose the
   * internally evolving `loss_based_result_` or uninitialized current-best.
   */
  get targetBitrateBps() {
    return this.getLossBasedResult().bandwidthEstimateBps;
  }

  get lossState(): LossBasedState {
    return this.getLossBasedResult().state;
  }

  /**
   * @internal test hook — pin `loss_based_result_.state`.
   * Production callers use {@link lossState}.
   */
  private get state(): LossBasedState {
    return this.lossBasedResult.state;
  }
  private set state(s: LossBasedState) {
    this.lossBasedResult.state = s;
  }

  /**
   * @internal test hook — pin `current_best_estimate_`.
   * Mutating fields updates the candidate model, not the published result.
   */
  private get current(): ChannelParameters {
    return this.currentBestEstimate;
  }

  get averageLossRatio(): number {
    return this.averageReportedLossRatio;
  }

  get inherentLossEstimate(): number {
    return this.currentBestEstimate.inherentLoss;
  }

  /** Number of committed observations (for readiness tests). */
  get observationCount(): number {
    return this.numObservations;
  }

  /**
   * pin `LossBasedBweV2::GetLossBasedResult`.
   * `ready` is {@link isReady}. Controllers must ignore
   * `bandwidthEstimateBps` until `ready` (pin
   * `LossBasedBandwidthEstimatorV2ReadyForUse`).
   */
  getLossBasedResult(): LossBasedResult {
    if (!this.isReady) {
      return {
        ready: false,
        bandwidthEstimateBps:
          this.delayBasedBps > 0
            ? this.delayBasedBps
            : Number.POSITIVE_INFINITY,
        state: "delay_based",
      };
    }
    return {
      ready: true,
      bandwidthEstimateBps: this.lossBasedResult.bandwidthEstimateBps,
      state: this.lossBasedResult.state,
    };
  }

  setBitrateIfHigher(bps: number) {
    if (bps > this.currentBestEstimate.lossLimitedBandwidthBps) {
      this.currentBestEstimate.lossLimitedBandwidthBps = clamp(bps);
    }
  }

  /**
   * @param lossFraction fallback when packet counts are 0
   * @param delayBasedBps delay-based A_hat
   * @param acknowledgedBps recent acked bitrate (TWCC-relative throughput)
   * @param packetCount known packets in batch
   * @param lostCount lost among known
   * @param firstSendMs actual first send time of this batch (send timeline)
   * @param batchBytes total sent bytes in batch
   * @param lastSendMs actual last send time of this batch (send timeline)
   * @param lostBytes lost bytes in batch (byte-loss mode); if 0 with losses,
   *   approximated from average packet size
   * @param packets optional per-packet feedback for soft-loss map
   * @param inAlr pin `GetCandidates(in_alr)` — skip acked-rate in ALR
   */
  update(
    lossFraction: number,
    delayBasedBps: number,
    acknowledgedBps = 0,
    packetCount = 0,
    lostCount = 0,
    firstSendMs = 0,
    batchBytes = 0,
    lastSendMs = 0,
    lostBytes = 0,
    packets?: LossPacketFeedback[],
    inAlr = false,
  ): number {
    this.inAlr = inAlr;
    if (acknowledgedBps > 0) {
      this.acknowledgedBps = acknowledgedBps;
      this.calculateInstantLowerBound();
    }
    // pin always assigns delay_based_estimate_ (PlusInfinity → 0 here).
    // Keep a stale delay cap only when the caller still has a finite limit.
    this.delayBasedBps = delayBasedBps > 0 ? delayBasedBps : 0;

    const n = packetCount > 0 ? packetCount : 0;
    const lost =
      packetCount > 0
        ? lostCount
        : Math.round(Math.min(Math.max(lossFraction, 0), 1) * Math.max(n, 1));

    // Resolve send timeline: prefer explicit first/last; fall back to duration
    // style when lastSendMs < firstSendMs (legacy test: last arg was duration).
    let batchFirst = firstSendMs;
    let batchLast = lastSendMs;
    if (batchLast > 0 && batchFirst > 0 && batchLast < batchFirst) {
      // Interpreted as (nowMs, sendDurationMs) legacy — do not use for real path.
      batchLast = batchFirst;
      batchFirst = batchFirst - lastSendMs;
    }
    if (batchLast <= 0 && batchFirst > 0) {
      batchLast = batchFirst;
    }

    let committed = false;
    if (n > 0 || (packets && packets.length > 0)) {
      committed = this.accumulatePartial(
        n,
        lost,
        batchBytes,
        lostBytes,
        batchFirst,
        batchLast,
        packets,
      );
    }

    // pin UpdateBandwidthEstimate: no new observation → return without
    // Newton / state transition. GetLossBasedResult still tracks the latest
    // delay-based estimate while !IsReady().
    if (!committed) {
      return this.getLossBasedResult().bandwidthEstimateBps;
    }

    // pin: first valid current_best_estimate_ is delay_based_estimate_.
    if (!this.currentBestInitialized) {
      if (!(this.delayBasedBps > 0)) {
        return this.getLossBasedResult().bandwidthEstimateBps;
      }
      this.currentBestEstimate.lossLimitedBandwidthBps = this.delayBasedBps;
      this.lossBasedResult = {
        bandwidthEstimateBps: this.delayBasedBps,
        state: "delay_based",
      };
      this.currentBestInitialized = true;
    }

    this.updateAverageReportedLossRatio();
    this.calculateInstantUpperBound();
    this.calculateInstantLowerBound();

    const currentBw = this.currentBestEstimate.lossLimitedBandwidthBps;
    let best = { ...this.currentBestEstimate };
    let bestObjective = Number.NEGATIVE_INFINITY;

    for (const candidate of this.getCandidates(this.inAlr)) {
      this.newtonsMethodUpdate(candidate);
      const obj = this.getObjective(candidate);
      if (
        obj > bestObjective ||
        (obj === bestObjective &&
          candidate.lossLimitedBandwidthBps > best.lossLimitedBandwidthBps)
      ) {
        bestObjective = obj;
        best = candidate;
      }
    }

    // Do not increase if average loss exceeds inherent loss estimate.
    if (
      kLossBasedNotIncreaseIfInherentLessThanAverage &&
      this.averageReportedLossRatio > best.inherentLoss &&
      currentBw < best.lossLimitedBandwidthBps
    ) {
      best.lossLimitedBandwidthBps = currentBw;
    }

    // pin order after best: delayed-increase cap → acked ramp-up cap →
    // decreasing→increasing 1bps nudge. Acked cap is **not** in GetCandidates.
    if (this.isInLossLimitedState()) {
      if (
        Number.isFinite(this.recoveringAfterLossMs) &&
        this.recoveringAfterLossMs + kLossBasedDelayedIncreaseWindowMs >
          this.lastSendTimeMostRecentObservation &&
        best.lossLimitedBandwidthBps > this.bandwidthLimitInCurrentWindow
      ) {
        best.lossLimitedBandwidthBps = this.bandwidthLimitInCurrentWindow;
      }

      const increasingWhenLossLimited =
        this.isEstimateIncreasingWhenLossLimited(
          currentBw,
          best.lossLimitedBandwidthBps,
        );
      if (increasingWhenLossLimited && this.acknowledgedBps > 0) {
        const rampupCap = this.acknowledgedBps * this.rampupBoundFactor();
        best.lossLimitedBandwidthBps = Math.max(
          currentBw,
          Math.min(best.lossLimitedBandwidthBps, rampupCap),
        );
        // pin: if acked cap pinned the estimate to current while decreasing,
        // raise 1bps so state can switch to kIncreasing / padding.
        if (
          this.lossBasedResult.state === "decreasing" &&
          best.lossLimitedBandwidthBps === currentBw
        ) {
          best.lossLimitedBandwidthBps = currentBw + 1;
        }
      }
    }

    // Bound best candidate by instant bounds (+ delay-based when available).
    let bounded = best.lossLimitedBandwidthBps;
    const upper = this.cachedInstantUpperBoundBps;
    const lower = this.cachedInstantLowerBoundBps;
    const delayCap = this.delayBasedCapBps();
    if (Number.isFinite(delayCap)) {
      bounded = Math.max(lower, Math.min(bounded, upper, delayCap));
    } else {
      bounded = Math.max(lower, Math.min(bounded, upper));
    }

    if (
      kLossBasedBoundBestCandidate &&
      bounded < best.lossLimitedBandwidthBps
    ) {
      this.currentBestEstimate.lossLimitedBandwidthBps = clamp(bounded);
      this.currentBestEstimate.inherentLoss = 0;
    } else {
      this.currentBestEstimate = best;
      this.currentBestEstimate.lossLimitedBandwidthBps = clamp(
        Math.max(this.currentBestEstimate.lossLimitedBandwidthBps, lower),
      );
    }

    // HOLD: publish min(holdRate, bounded) without rewriting currentBestEstimate.
    // pin keeps kDecreasing while last_hold_info_.timestamp is in the future.
    const lastSend = this.lastSendTimeMostRecentObservation;
    if (
      this.lossBasedResult.state === "decreasing" &&
      this.holdUntilMs > lastSend &&
      bounded < delayCap
    ) {
      this.holdRateBps = Math.max(lower, this.holdRateBps);
      this.lossBasedResult.bandwidthEstimateBps = clamp(
        Math.min(this.holdRateBps, bounded),
      );
      return this.getLossBasedResult().bandwidthEstimateBps;
    }

    this.updateState(
      this.lossBasedResult.bandwidthEstimateBps,
      bounded,
      lastSend,
    );

    if (this.isInLossLimitedState()) {
      if (
        !Number.isFinite(this.recoveringAfterLossMs) ||
        this.recoveringAfterLossMs + kLossBasedDelayedIncreaseWindowMs <
          lastSend
      ) {
        this.bandwidthLimitInCurrentWindow = Math.max(
          kMinBitrateBps,
          this.currentBestEstimate.lossLimitedBandwidthBps *
            kLossBasedMaxIncreaseFactor,
        );
        this.recoveringAfterLossMs = lastSend;
      }
    }

    return this.getLossBasedResult().bandwidthEstimateBps;
  }

  /**
   * pin state transition after HOLD early-return is skipped.
   * `prev` is the previously **published** `loss_based_result_.bandwidth_estimate`.
   * `next` is the bounded candidate (not necessarily `current_best_estimate_`).
   */
  private updateState(prev: number, next: number, lastSendMs: number) {
    const delayCap = this.delayBasedCapBps();
    const belowDelay = next < delayCap;
    const belowMax = next < this.maxBitrateBps;

    if (
      this.isEstimateIncreasingWhenLossLimited(prev, next) &&
      this.canKeepIncreasingState(next) &&
      belowDelay &&
      belowMax
    ) {
      this.enterIncreasingState(next, lastSendMs);
    } else if (belowDelay && belowMax) {
      // Arm HOLD only when *entering* decreasing. Stepwise extra decreases
      // keep the existing last_hold_info_ (pin hold_duration_factor > 0).
      if (
        this.lossBasedResult.state !== "decreasing" &&
        kLossBasedHoldDurationFactor > 0
      ) {
        this.armHold(next, lastSendMs);
      }
      this.clearPaddingInfo();
      this.lossBasedResult.state = "decreasing";
    } else {
      this.resetHold();
      this.clearPaddingInfo();
      this.lossBasedResult.state = "delay_based";
    }
    this.lossBasedResult.bandwidthEstimateBps = clamp(next);
  }

  /** pin `delay_based_estimate_` defaults to +∞ when unset. */
  private delayBasedCapBps(): number {
    return this.delayBasedBps > 0
      ? this.delayBasedBps
      : Number.POSITIVE_INFINITY;
  }

  /**
   * pin `last_hold_info_` arm: hold_until = now + *current* duration
   * (first time 300ms), then duration *= factor for the *next* HOLD.
   */
  private armHold(rateBps: number, lastSendMs: number) {
    this.holdUntilMs = lastSendMs + this.holdDurationMs;
    this.holdRateBps = rateBps;
    this.holdDurationMs = Math.min(
      kLossBasedMaxHoldDurationMs,
      Math.max(
        kLossBasedInitHoldDurationMs,
        this.holdDurationMs * kLossBasedHoldDurationFactor,
      ),
    );
  }

  private resetHold() {
    this.holdUntilMs = Number.NEGATIVE_INFINITY;
    this.holdDurationMs = kLossBasedInitHoldDurationMs;
    this.holdRateBps = kMaxBitrateBps;
  }

  private clearPaddingInfo() {
    this.lastPaddingMs = Number.NEGATIVE_INFINITY;
    this.lastPaddingRateBps = 0;
  }

  /**
   * pin `IsEstimateIncreasingWhenLossLimited`.
   * Flat estimate still counts as increasing while already
   * `increasing` / `increase_using_padding`.
   */
  private isEstimateIncreasingWhenLossLimited(
    prev: number,
    next: number,
  ): boolean {
    if (!this.isInLossLimitedState()) return false;
    if (next > prev) return true;
    return (
      next === prev &&
      (this.lossBasedResult.state === "increasing" ||
        this.lossBasedResult.state === "increase_using_padding")
    );
  }

  /**
   * pin `CanKeepIncreasingState`.
   * While `increase_using_padding`, keep the state if the padding window
   * (last_padding + PaddingDuration) still covers the latest send time,
   * or if the estimate rose above the last padding rate.
   */
  private canKeepIncreasingState(estimateBps: number): boolean {
    if (
      this.paddingDurationMs <= 0 ||
      this.lossBasedResult.state !== "increase_using_padding"
    ) {
      return true;
    }
    return (
      this.lastPaddingMs + this.paddingDurationMs >=
        this.lastSendTimeMostRecentObservation ||
      this.lastPaddingRateBps < estimateBps
    );
  }

  /**
   * pin: when PaddingDuration > 0 and estimate is increasing while
   * loss-limited, state is kIncreaseUsingPadding; otherwise kIncreasing.
   */
  private enterIncreasingState(nextBps: number, lastSendMs: number) {
    if (this.paddingDurationMs > 0) {
      if (nextBps > this.lastPaddingRateBps) {
        this.lastPaddingRateBps = nextBps;
        this.lastPaddingMs = lastSendMs;
      }
      this.lossBasedResult.state = "increase_using_padding";
      return;
    }
    this.lossBasedResult.state = "increasing";
  }

  /** pin: any state other than `kDelayBasedEstimate`. */
  private isInLossLimitedState(): boolean {
    return this.lossBasedResult.state !== "delay_based";
  }

  /**
   * libwebrtc: after HOLD, if acked has not recovered above
   * holdRate × BwRampupUpperBoundHoldThreshold (1.3), use 1.2× factor;
   * otherwise the normal 1.5× factor.
   */
  private rampupBoundFactor(): number {
    if (
      this.holdRateBps > 0 &&
      this.holdRateBps < kMaxBitrateBps &&
      this.acknowledgedBps > 0 &&
      this.acknowledgedBps <
        this.holdRateBps * kLossBasedRampupUpperBoundHoldThreshold
    ) {
      return kLossBasedRampupUpperBoundInHoldFactor;
    }
    return kLossBasedRampupUpperBoundFactor;
  }

  private accumulatePartial(
    numPackets: number,
    numLost: number,
    batchBytes: number,
    lostBytes: number,
    firstSendMs: number,
    lastSendMs: number,
    packets?: LossPacketFeedback[],
  ): boolean {
    if (packets && packets.length > 0) {
      // pin PushBackObservation: count/size grow on every feedback appearance.
      this.partial.numPackets += packets.length;
      let minSend = Number.POSITIVE_INFINITY;
      let maxSend = Number.NEGATIVE_INFINITY;
      for (const p of packets) {
        // Use the caller-supplied seq as-is (gcc passes unwrapped / generation
        // keys). Masking to 16-bit would merge wrap generations in one window.
        const seq = p.seq;
        if (p.received) {
          this.partial.lostPackets.delete(seq);
        } else {
          // emplace: first size wins; later not-received does not grow lost_size.
          if (!this.partial.lostPackets.has(seq)) {
            this.partial.lostPackets.set(seq, p.size);
          }
        }
        this.partial.size += p.size;
        if (Number.isFinite(p.sendMs)) {
          if (p.sendMs < minSend) minSend = p.sendMs;
          if (p.sendMs > maxSend) maxSend = p.sendMs;
        }
      }
      if (Number.isFinite(minSend)) firstSendMs = minSend;
      if (Number.isFinite(maxSend)) lastSendMs = maxSend;
    } else {
      this.partial.numPackets += numPackets;
      this.partial.size += batchBytes;
      // Aggregate soft-loss: synthetic seqs so later aggregate "received" cannot
      // unmark — tests without seq still work; real path should pass packets.
      const avgSize =
        numPackets > 0 ? Math.max(1, Math.round(batchBytes / numPackets)) : 1;
      const lostSize =
        lostBytes > 0 ? lostBytes : numLost > 0 ? avgSize * numLost : 0;
      // Represent lost packets as unique synthetic keys for this batch.
      const baseKey =
        (this.numObservations + 1) * 1_000_000 + this.partial.numPackets;
      for (let i = 0; i < numLost; i++) {
        const per =
          i === numLost - 1
            ? Math.max(1, lostSize - avgSize * (numLost - 1))
            : avgSize;
        this.partial.lostPackets.set(baseKey + i, per);
      }
    }

    if (!Number.isFinite(this.lastSendTimeMostRecentObservation)) {
      this.lastSendTimeMostRecentObservation = firstSendMs;
    }

    // Bound partial maps if the observation duration never advances
    // (identical send timestamps / stalled clock). Prefer dropping the
    // incomplete window over unbounded growth.
    if (this.partial.numPackets > LossBasedBwe.kMaxPartialPackets) {
      this.partial = {
        numPackets: 0,
        lostPackets: new Map(),
        size: 0,
      };
      this.lastSendTimeMostRecentObservation = lastSendMs;
      return false;
    }

    const observationDuration =
      lastSendMs - this.lastSendTimeMostRecentObservation;
    if (
      observationDuration <= 0 ||
      observationDuration < kLossBasedObservationDurationLowerBoundMs
    ) {
      return false;
    }

    this.lastSendTimeMostRecentObservation = lastSendMs;

    let lostSize = 0;
    for (const s of this.partial.lostPackets.values()) {
      lostSize += s;
    }
    const numLostPackets = this.partial.lostPackets.size;
    const numPkts = this.partial.numPackets;
    const instantaneous =
      this.partial.size > 0 && observationDuration > 0
        ? (this.partial.size * 8 * 1000) / observationDuration
        : this.acknowledgedBps > 0
          ? this.acknowledgedBps
          : this.currentBestEstimate.lossLimitedBandwidthBps;
    const sendingRateBps = this.getSendingRate(instantaneous);

    this.commitObservation({
      numPackets: numPkts,
      numLostPackets: numLostPackets,
      numReceivedPackets: Math.max(0, numPkts - numLostPackets),
      size: this.partial.size,
      lostSize,
      sendingRateBps,
    });

    this.partial = {
      numPackets: 0,
      lostPackets: new Map(),
      size: 0,
    };
    return true;
  }

  private commitObservation(o: Omit<Observation, "id">) {
    const obs: Observation = {
      ...o,
      id: this.numObservations++,
    };
    this.observations.push(obs);
    while (this.observations.length > kLossBasedObservationWindow) {
      this.observations.shift();
    }
    this.updateAverageReportedLossRatio();
    this.calculateInstantUpperBound();
  }

  private recomputeTemporalWeights() {
    this.temporalWeights = [];
    this.instantTemporalWeights = [];
    for (let i = 0; i < kLossBasedObservationWindow; i++) {
      this.temporalWeights.push(kLossBasedTemporalWeightFactor ** i);
      this.instantTemporalWeights.push(
        kLossBasedInstantUpperBoundTemporalWeightFactor ** i,
      );
    }
  }

  private temporalWeightFor(observation: Observation): number {
    const age = this.numObservations - 1 - observation.id;
    if (age < 0 || age >= this.temporalWeights.length) {
      return kLossBasedTemporalWeightFactor ** Math.max(age, 0);
    }
    return this.temporalWeights[age];
  }

  /** pin instant_upper_bound_temporal_weights_ for average loss ratio. */
  private instantTemporalWeightFor(observation: Observation): number {
    const age = this.numObservations - 1 - observation.id;
    if (age < 0 || age >= this.instantTemporalWeights.length) {
      return (
        kLossBasedInstantUpperBoundTemporalWeightFactor ** Math.max(age, 0)
      );
    }
    return this.instantTemporalWeights[age];
  }

  /** pin `GetSendingRate` (smoothing default 0). */
  private getSendingRate(instantaneousBps: number): number {
    if (this.numObservations <= 0) return instantaneousBps;
    const prev = this.observations[this.observations.length - 1];
    if (!prev || !(prev.sendingRateBps > 0)) return instantaneousBps;
    return (
      kLossBasedSendingRateSmoothingFactor * prev.sendingRateBps +
      (1 - kLossBasedSendingRateSmoothingFactor) * instantaneousBps
    );
  }

  private updateAverageReportedLossRatio() {
    if (this.observations.length === 0) {
      this.averageReportedLossRatio = 0;
      return;
    }
    if (kLossBasedUseByteLossRate) {
      this.averageReportedLossRatio =
        this.calculateAverageReportedByteLossRatio();
    } else {
      let lost = 0;
      let total = 0;
      for (const o of this.observations) {
        const w = this.instantTemporalWeightFor(o);
        lost += w * o.numLostPackets;
        total += w * o.numPackets;
      }
      this.averageReportedLossRatio = total > 0 ? lost / total : 0;
    }
  }

  /**
   * pin `CalculateAverageReportedByteLossRatio`.
   * When more than 3 observations exist, drop the min and max loss-rate
   * windows unless the max-loss window's send rate is ≥ median × 2.
   */
  private calculateAverageReportedByteLossRatio(): number {
    if (this.observations.length === 0) return 0;
    let lost = 0;
    let total = 0;
    let minLossRate = 1;
    let maxLossRate = 0;
    let minLost = 0;
    let maxLost = 0;
    let minBytes = 0;
    let maxBytes = 0;
    let sendRateOfMaxLoss = 0;
    for (const o of this.observations) {
      const w = this.instantTemporalWeightFor(o);
      const wLost = w * o.lostSize;
      const wSize = w * o.size;
      lost += wLost;
      total += wSize;
      const lossRate = o.size > 0 ? o.lostSize / o.size : 0;
      if (this.numObservations > 3) {
        if (lossRate > maxLossRate) {
          maxLossRate = lossRate;
          maxLost = wLost;
          maxBytes = wSize;
          sendRateOfMaxLoss = o.sendingRateBps;
        }
        if (lossRate < minLossRate) {
          minLossRate = lossRate;
          minLost = wLost;
          minBytes = wSize;
        }
      }
    }
    if (total <= 0) return 0;
    if (
      this.getMedianSendingRate() * kLossBasedMedianSendingRateFactor <=
      sendRateOfMaxLoss
    ) {
      return lost / total;
    }
    if (total === maxBytes + minBytes) {
      return lost / total;
    }
    const filteredLost = lost - minLost - maxLost;
    const filteredTotal = total - maxBytes - minBytes;
    if (filteredTotal <= 0) return 0;
    return filteredLost / filteredTotal;
  }

  private getMedianSendingRate(): number {
    const rates = this.observations
      .map((o) => o.sendingRateBps)
      .filter((r) => Number.isFinite(r) && r > 0)
      .sort((a, b) => a - b);
    if (rates.length === 0) return 0;
    const mid = Math.floor(rates.length / 2);
    if (rates.length % 2 === 0) {
      return (rates[mid - 1]! + rates[mid]!) / 2;
    }
    return rates[mid]!;
  }

  private calculateInstantUpperBound() {
    let instant = this.maxBitrateBps;
    if (this.averageReportedLossRatio > kLossBasedInstantUpperBoundLossOffset) {
      instant =
        kLossBasedInstantUpperBoundBwBalanceBps /
        (this.averageReportedLossRatio - kLossBasedInstantUpperBoundLossOffset);
    }
    this.cachedInstantUpperBoundBps = instant;
  }

  private calculateInstantLowerBound() {
    let lower = 0;
    if (this.acknowledgedBps > 0 && kLossBasedLowerBoundByAckedRateFactor > 0) {
      lower = kLossBasedLowerBoundByAckedRateFactor * this.acknowledgedBps;
    }
    lower = Math.max(lower, this.minBitrateBps);
    this.cachedInstantLowerBoundBps = lower;
  }

  /**
   * pin `GetCandidateBandwidthUpperBound`.
   * Delayed-increase window (when loss-limited) or configured max.
   * Acked-rate ramp-up (1.5× / 1.2×) is **not** applied here.
   */
  private getCandidateBandwidthUpperBound(): number {
    let upper = this.maxBitrateBps;
    if (
      this.isInLossLimitedState() &&
      Number.isFinite(this.bandwidthLimitInCurrentWindow)
    ) {
      upper = this.bandwidthLimitInCurrentWindow;
    }
    return upper;
  }

  private getCandidates(inAlr = this.inAlr): ChannelParameters[] {
    const currentBw = this.currentBestEstimate.lossLimitedBandwidthBps;
    const bandwidths: number[] = [];
    for (const f of kLossBasedCandidateFactors) {
      bandwidths.push(currentBw * f);
    }
    if (this.acknowledgedBps > 0) {
      const skipAckedInAlr = kLossBasedNotUseAckedRateInAlr && inAlr;
      const paddingWindowOpen =
        this.paddingDurationMs > 0 &&
        this.lastPaddingMs + this.paddingDurationMs >=
          this.lastSendTimeMostRecentObservation;
      if (!skipAckedInAlr || paddingWindowOpen) {
        bandwidths.push(
          this.acknowledgedBps * kLossBasedBandwidthBackoffLowerBoundFactor,
        );
      }
    }
    if (this.delayBasedBps > currentBw) {
      bandwidths.push(this.delayBasedBps);
    }

    const candidateUpper = this.getCandidateBandwidthUpperBound();
    return bandwidths.map((bw) => {
      const candidate: ChannelParameters = {
        inherentLoss: this.currentBestEstimate.inherentLoss,
        // pin GetCandidates: no extra configured-max clamp before Newton.
        lossLimitedBandwidthBps: Math.min(
          bw,
          Math.max(currentBw, candidateUpper),
        ),
      };
      candidate.inherentLoss = this.getFeasibleInherentLoss(candidate);
      return candidate;
    });
  }

  /**
   * libwebrtc loss probability:
   * inherent + (1 - inherent) * max(0, sending - bw) / sending
   */
  private getLossProbability(
    inherentLoss: number,
    lossLimitedBw: number,
    sendingRate: number,
  ): number {
    const inherent = Math.min(Math.max(inherentLoss, 0), 1);
    let p = inherent;
    if (sendingRate > 0 && sendingRate > lossLimitedBw) {
      p += (1 - inherent) * ((sendingRate - lossLimitedBw) / sendingRate);
    }
    return Math.min(Math.max(p, 1e-6), 1 - 1e-6);
  }

  private getInherentLossUpperBound(bandwidthBps: number): number {
    if (bandwidthBps <= 0) return 1;
    const ub =
      kLossBasedInherentLossUpperBoundOffset +
      kLossBasedInherentLossUpperBoundBwBalanceBps / bandwidthBps;
    return Math.min(ub, 1);
  }

  private getFeasibleInherentLoss(c: ChannelParameters): number {
    return Math.min(
      Math.max(c.inherentLoss, kLossBasedInherentLossLowerBound),
      this.getInherentLossUpperBound(c.lossLimitedBandwidthBps),
    );
  }

  private toKiloBytes(bytes: number): number {
    return bytes / 1000;
  }

  private getDerivatives(c: ChannelParameters): {
    first: number;
    second: number;
  } {
    let first = 0;
    let second = 0;
    for (const o of this.observations) {
      const lp = this.getLossProbability(
        c.inherentLoss,
        c.lossLimitedBandwidthBps,
        o.sendingRateBps,
      );
      const w = this.temporalWeightFor(o);
      if (kLossBasedUseByteLossRate) {
        const lostKb = this.toKiloBytes(o.lostSize);
        const receivedKb = this.toKiloBytes(o.size - o.lostSize);
        first += w * (lostKb / lp - receivedKb / (1 - lp));
        second -= w * (lostKb / lp ** 2 + receivedKb / (1 - lp) ** 2);
      } else {
        first += w * (o.numLostPackets / lp - o.numReceivedPackets / (1 - lp));
        second -=
          w *
          (o.numLostPackets / lp ** 2 + o.numReceivedPackets / (1 - lp) ** 2);
      }
    }
    if (second >= 0) second = -1e-6;
    return { first, second };
  }

  private newtonsMethodUpdate(c: ChannelParameters) {
    if (this.observations.length === 0) return;
    for (let i = 0; i < kLossBasedNewtonIterations; i++) {
      const d = this.getDerivatives(c);
      c.inherentLoss -= (kLossBasedNewtonStepSize * d.first) / d.second;
      c.inherentLoss = this.getFeasibleInherentLoss(c);
    }
  }

  /**
   * Adjust bias factor by current average loss
   * (libwebrtc `AdjustBiasFactor`).
   */
  private adjustBiasFactor(lossRate: number, biasFactor: number): number {
    return (
      (biasFactor *
        (kLossBasedLossThresholdOfHighBandwidthPreference - lossRate)) /
      (kLossBasedBandwidthPreferenceSmoothingFactor +
        Math.abs(kLossBasedLossThresholdOfHighBandwidthPreference - lossRate))
    );
  }

  private getHighBandwidthBias(bandwidthBps: number): number {
    if (!(bandwidthBps > 0)) return 0;
    const kbps = bandwidthBps / 1000;
    const loss = this.averageReportedLossRatio;
    return (
      this.adjustBiasFactor(loss, kLossBasedHigherBwBiasFactor) * kbps +
      this.adjustBiasFactor(loss, kLossBasedHigherLogBwBiasFactor) *
        Math.log(1 + kbps)
    );
  }

  private getObjective(c: ChannelParameters): number {
    let objective = 0;
    const bias = this.getHighBandwidthBias(c.lossLimitedBandwidthBps);
    for (const o of this.observations) {
      const lp = this.getLossProbability(
        c.inherentLoss,
        c.lossLimitedBandwidthBps,
        o.sendingRateBps,
      );
      const w = this.temporalWeightFor(o);
      if (kLossBasedUseByteLossRate) {
        const lostKb = this.toKiloBytes(o.lostSize);
        const receivedKb = this.toKiloBytes(o.size - o.lostSize);
        objective +=
          w * (lostKb * Math.log(lp) + receivedKb * Math.log(1 - lp));
        objective += w * bias * this.toKiloBytes(o.size);
      } else {
        objective +=
          w *
          (o.numLostPackets * Math.log(lp) +
            o.numReceivedPackets * Math.log(1 - lp));
        objective += w * bias * o.numPackets;
      }
    }
    return objective;
  }
}

function clamp(bps: number) {
  return Math.min(Math.max(Math.round(bps), kMinBitrateBps), kMaxBitrateBps);
}

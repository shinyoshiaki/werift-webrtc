import {
  kBeta,
  kDefaultRttMs,
  kDefaultStartBitrateBps,
  kMaxBitrateBps,
  kMinBitrateBps,
  kMultiplicativeIncreaseFactor,
  kReactionTimeMs,
  kThroughputLowerFraction,
} from "./constants";
import { LinkCapacityEstimator } from "./linkCapacityEstimator";
import type { BandwidthUsage } from "./overuseDetector";

type RateControlState = "hold" | "increase" | "decrease";

/**
 * AIMD rate controller for the delay-based estimate (pin
 * `modules/remote_bitrate_estimator/aimd_rate_control.{h,cc}`).
 *
 * Ports ChangeState / ChangeBitrate / MultiplicativeRateIncrease /
 * AdditiveRateIncrease / TimeToReduceFurther / GetNearMaxIncreaseRate.
 *
 * RTT is **only** via {@link setRtt} (RTCP / OnRoundTripTimeUpdate path) —
 * never from TWCC propagation RTT / RttBasedBackoff.
 */
export class AimdRateControl {
  private minConfiguredBps = kMinBitrateBps;
  private maxConfiguredBps = kMaxBitrateBps;
  private currentBitrateBps = kDefaultStartBitrateBps;
  private latestEstimatedThroughputBps = kDefaultStartBitrateBps;
  private readonly linkCapacity = new LinkCapacityEstimator();
  private rateControlState: RateControlState = "hold";
  /** Pin `time_last_bitrate_change_` — used by TimeToReduceFurther. */
  private timeLastBitrateChangeMs = Number.NEGATIVE_INFINITY;
  private timeLastBitrateDecreaseMs = Number.NEGATIVE_INFINITY;
  private timeFirstThroughputEstimateMs = Number.NEGATIVE_INFINITY;
  private bitrateIsInitialized = false;
  private readonly beta = kBeta;
  private inAlr = false;
  /** Default 200ms (pin kDefaultRtt). Updated only via {@link setRtt}. */
  private rttMs = kDefaultRttMs;
  /** send_side AIMD (GoogCc uses send-side). */
  private readonly sendSide = true;
  private readonly noBitrateIncreaseInAlr = false;

  reset(startBps = kDefaultStartBitrateBps) {
    this.minConfiguredBps = kMinBitrateBps;
    this.maxConfiguredBps = kMaxBitrateBps;
    this.currentBitrateBps = clamp(startBps, this.minConfiguredBps, this.maxConfiguredBps);
    this.latestEstimatedThroughputBps = this.currentBitrateBps;
    this.linkCapacity.reset();
    this.rateControlState = "hold";
    this.timeLastBitrateChangeMs = Number.NEGATIVE_INFINITY;
    this.timeLastBitrateDecreaseMs = Number.NEGATIVE_INFINITY;
    this.timeFirstThroughputEstimateMs = Number.NEGATIVE_INFINITY;
    this.bitrateIsInitialized = startBps > 0;
    this.inAlr = false;
    this.rttMs = kDefaultRttMs;
  }

  setStartBitrate(startBps: number) {
    this.currentBitrateBps = clamp(startBps, this.minConfiguredBps, this.maxConfiguredBps);
    this.latestEstimatedThroughputBps = this.currentBitrateBps;
    this.bitrateIsInitialized = true;
  }

  setMinBitrate(minBps: number) {
    this.minConfiguredBps = Math.max(0, minBps);
    this.currentBitrateBps = Math.max(this.minConfiguredBps, this.currentBitrateBps);
  }

  /**
   * State-preserving estimate update (pin `AimdRateControl::SetEstimate`).
   * Used for valid probe results — does not wipe RTT or link-capacity history.
   */
  setEstimate(bitrateBps: number, atTimeMs: number) {
    this.bitrateIsInitialized = true;
    const prev = this.currentBitrateBps;
    this.currentBitrateBps = this.clampBitrate(bitrateBps);
    this.timeLastBitrateChangeMs = atTimeMs;
    if (this.currentBitrateBps < prev) {
      this.timeLastBitrateDecreaseMs = atTimeMs;
    }
  }

  /**
   * pin `AimdRateControl::SetRtt` — RTCP / network-controller RTT only.
   * No clamp to 2000ms; TimeToReduceFurther clamps to [10, 200] ms internally.
   */
  setRtt(rttMs: number) {
    if (Number.isFinite(rttMs) && rttMs > 0) {
      this.rttMs = rttMs;
    }
  }

  get rtt(): number {
    return this.rttMs;
  }

  get targetBitrateBps() {
    return this.currentBitrateBps;
  }

  get controlState(): RateControlState {
    return this.rateControlState;
  }

  setInApplicationLimitedRegion(inAlr: boolean) {
    this.inAlr = inAlr;
  }

  validEstimate(): boolean {
    return this.bitrateIsInitialized;
  }

  /**
   * @param usage overuse detector state
   * @param acknowledgedBitrateBps estimated throughput R_hat (acked bitrate)
   * @param nowMs feedback / wall clock ms
   */
  update(
    usage: BandwidthUsage,
    acknowledgedBitrateBps: number,
    nowMs: number,
  ): number {
    // pin: initialize from throughput after 5s of samples (we still accept
    // explicit setStartBitrate / setEstimate earlier).
    if (!this.bitrateIsInitialized) {
      const kInitializationTimeMs = 5_000;
      if (
        !Number.isFinite(this.timeFirstThroughputEstimateMs) ||
        this.timeFirstThroughputEstimateMs < 0
      ) {
        if (acknowledgedBitrateBps > 0) {
          this.timeFirstThroughputEstimateMs = nowMs;
        }
      } else if (
        nowMs - this.timeFirstThroughputEstimateMs > kInitializationTimeMs &&
        acknowledgedBitrateBps > 0
      ) {
        this.currentBitrateBps = acknowledgedBitrateBps;
        this.bitrateIsInitialized = true;
      }
    }

    // pin DelayBasedBwe::MaybeUpdateEstimate gates overuse updates with
    // TimeToReduceFurther / InitialTimeToReduceFurther before calling Update.
    if (usage === "overuse") {
      if (acknowledgedBitrateBps > 0) {
        if (
          this.bitrateIsInitialized &&
          !this.timeToReduceFurther(nowMs, acknowledgedBitrateBps)
        ) {
          return this.currentBitrateBps;
        }
      } else if (this.bitrateIsInitialized) {
        if (!this.initialTimeToReduceFurther(nowMs)) {
          return this.currentBitrateBps;
        }
        // No throughput yet: reduce by 50% (pin InitialTimeToReduceFurther path).
        this.setEstimate(this.currentBitrateBps / 2, nowMs);
        return this.currentBitrateBps;
      }
    }

    this.changeBitrate(usage, acknowledgedBitrateBps, nowMs);
    return this.currentBitrateBps;
  }

  /**
   * pin `TimeToReduceFurther`:
   * - allow after clamp(rtt, 10ms, 200ms) since last bitrate **change**
   * - or when estimated_throughput < 0.5 * LatestEstimate
   */
  timeToReduceFurther(nowMs: number, estimatedThroughputBps: number): boolean {
    const reductionIntervalMs = Math.min(200, Math.max(10, this.rttMs));
    // pin: time_last_bitrate_change_ starts MinusInfinity → first reduce always OK
    if (
      !Number.isFinite(this.timeLastBitrateChangeMs) ||
      nowMs - this.timeLastBitrateChangeMs >= reductionIntervalMs
    ) {
      return true;
    }
    if (this.bitrateIsInitialized) {
      const threshold = this.currentBitrateBps * kThroughputLowerFraction;
      return estimatedThroughputBps > 0 && estimatedThroughputBps < threshold;
    }
    return false;
  }

  /** pin `InitialTimeToReduceFurther`. */
  initialTimeToReduceFurther(nowMs: number): boolean {
    return (
      this.bitrateIsInitialized &&
      this.timeToReduceFurther(
        nowMs,
        this.currentBitrateBps / 2 - 1,
      )
    );
  }

  /**
   * pin `GetNearMaxIncreaseRateBpsPerSecond`:
   * response_time = (rtt + 100ms) * 2; min increase 4000 bps/s.
   */
  getNearMaxIncreaseRateBpsPerSecond(): number {
    const frameIntervalSec = 1 / 30;
    const frameSizeBits = this.currentBitrateBps * frameIntervalSec;
    const packetSizeBits = 1200 * 8;
    const packetsPerFrame = Math.max(1, Math.ceil(frameSizeBits / packetSizeBits));
    const avgPacketSizeBits = frameSizeBits / packetsPerFrame;
    // Approximate over-use estimator delay to 100 ms; double for response time.
    const responseTimeSec = ((this.rttMs + kReactionTimeMs) * 2) / 1000;
    const increaseRate =
      responseTimeSec > 0 ? avgPacketSizeBits / responseTimeSec : 4000;
    return Math.max(4000, increaseRate);
  }

  private changeBitrate(
    usage: BandwidthUsage,
    estimatedThroughputBps: number,
    nowMs: number,
  ) {
    let newBitrate: number | undefined;
    let estimatedThroughput =
      estimatedThroughputBps > 0
        ? estimatedThroughputBps
        : this.latestEstimatedThroughputBps;
    if (estimatedThroughputBps > 0) {
      this.latestEstimatedThroughputBps = estimatedThroughputBps;
      estimatedThroughput = estimatedThroughputBps;
    }

    // An over-use always triggers a reduce path even before first estimate.
    if (!this.bitrateIsInitialized && usage !== "overuse") {
      return;
    }

    this.changeState(usage, nowMs);

    switch (this.rateControlState) {
      case "hold":
        break;

      case "increase": {
        if (estimatedThroughput > this.linkCapacity.upperBoundBps()) {
          this.linkCapacity.reset();
        }

        // pin: 1.5 * throughput + 10 kbps
        let increaseLimit = 1.5 * estimatedThroughput + 10_000;
        if (this.sendSide && this.inAlr && this.noBitrateIncreaseInAlr) {
          increaseLimit = this.currentBitrateBps;
        }

        if (this.currentBitrateBps < increaseLimit) {
          let increased: number;
          if (this.linkCapacity.hasEstimate()) {
            const additive = this.additiveRateIncrease(
              nowMs,
              this.timeLastBitrateChangeMs,
            );
            increased = this.currentBitrateBps + additive;
          } else {
            const multi = this.multiplicativeRateIncrease(
              nowMs,
              this.timeLastBitrateChangeMs,
              this.currentBitrateBps,
            );
            increased = this.currentBitrateBps + multi;
          }
          newBitrate = Math.min(increased, increaseLimit);
        }
        this.timeLastBitrateChangeMs = nowMs;
        break;
      }

      case "decrease": {
        // pin: estimated_throughput * beta, then −5 kbps if above 5 kbps
        let decreased = estimatedThroughput * this.beta;
        if (decreased > 5_000) {
          decreased -= 5_000;
        }

        if (decreased > this.currentBitrateBps) {
          if (this.linkCapacity.hasEstimate()) {
            decreased = this.beta * this.linkCapacity.estimateBps();
          }
        }

        if (decreased < this.currentBitrateBps) {
          newBitrate = decreased;
        }

        if (
          this.bitrateIsInitialized &&
          estimatedThroughput < this.currentBitrateBps
        ) {
          // last_decrease_ tracked in pin; not required for external API
        }
        if (estimatedThroughput < this.linkCapacity.lowerBoundBps()) {
          this.linkCapacity.reset();
        }

        this.bitrateIsInitialized = true;
        this.linkCapacity.onOveruseDetected(estimatedThroughput);
        // Stay on hold until the pipes are cleared.
        this.rateControlState = "hold";
        this.timeLastBitrateChangeMs = nowMs;
        this.timeLastBitrateDecreaseMs = nowMs;
        break;
      }
    }

    this.currentBitrateBps = this.clampBitrate(
      newBitrate !== undefined ? newBitrate : this.currentBitrateBps,
    );
  }

  private changeState(usage: BandwidthUsage, nowMs: number) {
    switch (usage) {
      case "normal":
        if (this.rateControlState === "hold") {
          this.timeLastBitrateChangeMs = nowMs;
          this.rateControlState = "increase";
        }
        break;
      case "overuse":
        if (this.rateControlState !== "decrease") {
          this.rateControlState = "decrease";
        }
        break;
      case "underuse":
        this.rateControlState = "hold";
        break;
    }
  }

  private multiplicativeRateIncrease(
    atTimeMs: number,
    lastTimeMs: number,
    currentBitrateBps: number,
  ): number {
    let alpha = kMultiplicativeIncreaseFactor;
    if (Number.isFinite(lastTimeMs) && lastTimeMs > Number.NEGATIVE_INFINITY) {
      const timeSinceSec = Math.max(0, (atTimeMs - lastTimeMs) / 1000);
      alpha = kMultiplicativeIncreaseFactor ** Math.min(timeSinceSec, 1.0);
    }
    // max(current * (alpha - 1), 1000 bps)
    return Math.max(currentBitrateBps * (alpha - 1.0), 1000);
  }

  private additiveRateIncrease(atTimeMs: number, lastTimeMs: number): number {
    const timePeriodSec =
      Number.isFinite(lastTimeMs) && lastTimeMs > Number.NEGATIVE_INFINITY
        ? Math.max(0, (atTimeMs - lastTimeMs) / 1000)
        : 0;
    return this.getNearMaxIncreaseRateBpsPerSecond() * timePeriodSec;
  }

  private clampBitrate(newBitrateBps: number): number {
    // NetworkStateEstimate upper/lower bounds omitted (no network_estimator path).
    return Math.max(newBitrateBps, this.minConfiguredBps);
  }
}

function clamp(bps: number, minBps: number, maxBps: number) {
  return Math.min(Math.max(Math.round(bps), minBps), maxBps);
}

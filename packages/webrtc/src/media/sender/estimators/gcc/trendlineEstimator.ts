import {
  kInitialThresholdMs,
  kMaxAdaptOffsetMs,
  kMaxThresholdMs,
  kMinThresholdMs,
  kOveruseTimeThresholdMs,
  kThresholdGainDown,
  kThresholdGainUp,
  kTrendlineDeltaCounterMax,
  kTrendlineMinNumDeltas,
  kTrendlineSmoothingCoeff,
  kTrendlineThresholdGain,
  kTrendlineWindowSize,
} from "./constants";
import type { BandwidthUsage } from "./overuseDetector";

interface PacketTiming {
  /** Arrival time relative to first sample (ms). */
  arrivalTimeMs: number;
  smoothedDelayMs: number;
  rawDelayMs: number;
}

/**
 * libwebrtc TrendlineEstimator port
 * (`modules/congestion_controller/goog_cc/trendline_estimator.cc`).
 *
 * - Exponentially smoothed accumulated delay
 * - Linear regression slope only when the history window is **full**
 * - `modified_trend = min(num_deltas, 60) * trend * 4.0`
 * - Adaptive threshold with k_up=0.0087 / k_down=0.039
 * - Overuse / underuse / normal hypothesis (same role as OveruseDetector)
 */
export class TrendlineEstimator {
  private numOfDeltas = 0;
  private firstArrivalTimeMs = -1;
  private accumulatedDelay = 0;
  private smoothedDelay = 0;
  private readonly delayHist: PacketTiming[] = [];
  private prevTrend = 0;
  private threshold = kInitialThresholdMs;
  private timeOverUsing = -1;
  private overuseCounter = 0;
  private hypothesis: BandwidthUsage = "normal";
  private lastUpdateMs = -1;
  private prevModifiedTrend = 0;

  reset() {
    this.numOfDeltas = 0;
    this.firstArrivalTimeMs = -1;
    this.accumulatedDelay = 0;
    this.smoothedDelay = 0;
    this.delayHist.length = 0;
    this.prevTrend = 0;
    this.threshold = kInitialThresholdMs;
    this.timeOverUsing = -1;
    this.overuseCounter = 0;
    this.hypothesis = "normal";
    this.lastUpdateMs = -1;
    this.prevModifiedTrend = 0;
  }

  get state(): BandwidthUsage {
    return this.hypothesis;
  }

  get sampleCount() {
    return this.delayHist.length;
  }

  get numDeltas() {
    return this.numOfDeltas;
  }

  get trend() {
    return this.prevTrend;
  }

  get modifiedTrend() {
    return this.prevModifiedTrend;
  }

  get adaptiveThreshold() {
    return this.threshold;
  }

  /**
   * @param recvDeltaMs inter-arrival (ms)
   * @param sendDeltaMs inter-departure (ms) — also drives overuse timer
   * @param arrivalTimeMs absolute arrival time
   * @returns modified trend (for tests / logging)
   */
  update(
    recvDeltaMs: number,
    sendDeltaMs: number,
    arrivalTimeMs: number,
  ): number {
    const deltaMs = recvDeltaMs - sendDeltaMs;
    this.numOfDeltas = Math.min(
      this.numOfDeltas + 1,
      kTrendlineDeltaCounterMax,
    );
    if (this.firstArrivalTimeMs === -1) {
      this.firstArrivalTimeMs = arrivalTimeMs;
    }

    this.accumulatedDelay += deltaMs;
    this.smoothedDelay =
      kTrendlineSmoothingCoeff * this.smoothedDelay +
      (1 - kTrendlineSmoothingCoeff) * this.accumulatedDelay;

    this.delayHist.push({
      arrivalTimeMs: arrivalTimeMs - this.firstArrivalTimeMs,
      smoothedDelayMs: this.smoothedDelay,
      rawDelayMs: this.accumulatedDelay,
    });
    if (this.delayHist.length > kTrendlineWindowSize) {
      this.delayHist.shift();
    }

    // libwebrtc: only recompute slope when the window is full.
    let trend = this.prevTrend;
    if (this.delayHist.length === kTrendlineWindowSize) {
      trend = linearFitSlope(this.delayHist) ?? trend;
    }

    this.detect(trend, sendDeltaMs, arrivalTimeMs);
    return this.prevModifiedTrend;
  }

  /**
   * libwebrtc TrendlineEstimator::Detect
   */
  private detect(trend: number, tsDeltaMs: number, nowMs: number) {
    if (this.numOfDeltas < 2) {
      this.hypothesis = "normal";
      return;
    }

    const modifiedTrend =
      Math.min(this.numOfDeltas, kTrendlineMinNumDeltas) *
      trend *
      kTrendlineThresholdGain;
    this.prevModifiedTrend = modifiedTrend;

    if (modifiedTrend > this.threshold) {
      if (this.timeOverUsing === -1) {
        // Assume over-using half the time since previous sample.
        this.timeOverUsing = tsDeltaMs / 2;
      } else {
        this.timeOverUsing += tsDeltaMs;
      }
      this.overuseCounter++;
      if (
        this.timeOverUsing > kOveruseTimeThresholdMs &&
        this.overuseCounter > 1
      ) {
        if (trend >= this.prevTrend) {
          this.timeOverUsing = 0;
          this.overuseCounter = 0;
          this.hypothesis = "overuse";
        }
      }
    } else if (modifiedTrend < -this.threshold) {
      this.timeOverUsing = -1;
      this.overuseCounter = 0;
      this.hypothesis = "underuse";
    } else {
      this.timeOverUsing = -1;
      this.overuseCounter = 0;
      this.hypothesis = "normal";
    }

    this.prevTrend = trend;
    this.updateThreshold(modifiedTrend, nowMs);
  }

  private updateThreshold(modifiedTrend: number, nowMs: number) {
    if (this.lastUpdateMs === -1) {
      this.lastUpdateMs = nowMs;
    }

    if (Math.abs(modifiedTrend) > this.threshold + kMaxAdaptOffsetMs) {
      this.lastUpdateMs = nowMs;
      return;
    }

    const k =
      Math.abs(modifiedTrend) < this.threshold
        ? kThresholdGainDown
        : kThresholdGainUp;
    const timeDeltaMs = Math.min(nowMs - this.lastUpdateMs, 100);
    this.threshold += k * (Math.abs(modifiedTrend) - this.threshold) * timeDeltaMs;
    this.threshold = Math.min(
      Math.max(this.threshold, kMinThresholdMs),
      kMaxThresholdMs,
    );
    this.lastUpdateMs = nowMs;
  }
}

function linearFitSlope(packets: PacketTiming[]): number | undefined {
  if (packets.length < 2) return undefined;
  let sumX = 0;
  let sumY = 0;
  for (const p of packets) {
    sumX += p.arrivalTimeMs;
    sumY += p.smoothedDelayMs;
  }
  const xAvg = sumX / packets.length;
  const yAvg = sumY / packets.length;
  let numerator = 0;
  let denominator = 0;
  for (const p of packets) {
    const dx = p.arrivalTimeMs - xAvg;
    numerator += dx * (p.smoothedDelayMs - yAvg);
    denominator += dx * dx;
  }
  if (denominator === 0) return undefined;
  return numerator / denominator;
}

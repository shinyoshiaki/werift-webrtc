import {
  kTrendlineSmoothingCoeff,
  kTrendlineThresholdGain,
  kTrendlineWindowSize,
} from "./constants";

interface TrendPoint {
  arrivalTimeMs: number;
  smoothedDelayMs: number;
}

/**
 * libwebrtc-style TrendlineEstimator (delay gradient via linear regression).
 *
 * Port of the structure used in
 * `modules/congestion_controller/goog_cc/trendline_estimator.*`:
 * accumulated inter-arrival delay, exponential smoothing, then slope over a
 * fixed-size window of (arrival_time, smoothed_delay) samples.
 *
 * Preferred over the draft Kalman scalar filter when aligning with current
 * libwebrtc send-side BWE.
 */
export class TrendlineEstimator {
  private accumulatedDelayMs = 0;
  private smoothedDelayMs = 0;
  private firstArrivalMs = 0;
  private numDeltas = 0;
  private readonly window: TrendPoint[] = [];
  private trend = 0;

  reset() {
    this.accumulatedDelayMs = 0;
    this.smoothedDelayMs = 0;
    this.firstArrivalMs = 0;
    this.numDeltas = 0;
    this.window.length = 0;
    this.trend = 0;
  }

  /**
   * @param recvDeltaMs inter-arrival time of packet groups (ms)
   * @param sendDeltaMs inter-departure time of packet groups (ms)
   * @param arrivalTimeMs absolute arrival time of the current group
   * @returns estimated delay gradient trend (ms/ms-scale slope used by overuse detector as offset)
   */
  update(recvDeltaMs: number, sendDeltaMs: number, arrivalTimeMs: number): number {
    const deltaMs = recvDeltaMs - sendDeltaMs;
    this.numDeltas++;
    if (this.numDeltas === 1) {
      this.firstArrivalMs = arrivalTimeMs;
    }

    this.accumulatedDelayMs += deltaMs;
    this.smoothedDelayMs =
      kTrendlineSmoothingCoeff * this.smoothedDelayMs +
      (1 - kTrendlineSmoothingCoeff) * this.accumulatedDelayMs;

    this.window.push({
      arrivalTimeMs: arrivalTimeMs - this.firstArrivalMs,
      smoothedDelayMs: this.smoothedDelayMs,
    });
    if (this.window.length > kTrendlineWindowSize) {
      this.window.shift();
    }

    if (this.window.length >= 2) {
      this.trend = linearRegressionSlope(this.window);
    }
    // Scale trend like libwebrtc (threshold_gain applied later in detector input).
    return this.trend * kTrendlineThresholdGain;
  }

  get estimate() {
    return this.trend * kTrendlineThresholdGain;
  }

  get sampleCount() {
    return this.window.length;
  }
}

function linearRegressionSlope(points: TrendPoint[]): number {
  const n = points.length;
  let sumX = 0;
  let sumY = 0;
  for (const p of points) {
    sumX += p.arrivalTimeMs;
    sumY += p.smoothedDelayMs;
  }
  const avgX = sumX / n;
  const avgY = sumY / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    const dx = p.arrivalTimeMs - avgX;
    num += dx * (p.smoothedDelayMs - avgY);
    den += dx * dx;
  }
  if (den === 0) return 0;
  return num / den;
}

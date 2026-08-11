import {
  kInitialThresholdMs,
  kMaxAdaptOffsetMs,
  kMaxThresholdMs,
  kMinThresholdMs,
  kOveruseTimeThresholdMs,
  kThresholdGainDown,
  kThresholdGainUp,
} from "./constants";

export type BandwidthUsage = "normal" | "overuse" | "underuse";

/**
 * Adaptive-threshold over-use detector (draft-ietf-rmcat-gcc-02 §5.4).
 *
 * **Runtime note:** {@link TrendlineEstimator} embeds the same Detect /
 * UpdateThreshold logic (libwebrtc `TrendlineEstimator::Detect`). This class
 * is retained for unit tests and as the shared {@link BandwidthUsage} type
 * home; production GCC uses TrendlineEstimator only.
 */
export class OveruseDetector {
  private thresholdMs = kInitialThresholdMs;
  private lastUpdateMs = 0;
  private prevOffsetMs = 0;
  private timeOverUsingMs = -1;
  private overuseCounter = 0;
  private hypothesis: BandwidthUsage = "normal";

  reset() {
    this.thresholdMs = kInitialThresholdMs;
    this.lastUpdateMs = 0;
    this.prevOffsetMs = 0;
    this.timeOverUsingMs = -1;
    this.overuseCounter = 0;
    this.hypothesis = "normal";
  }

  get state(): BandwidthUsage {
    return this.hypothesis;
  }

  get threshold(): number {
    return this.thresholdMs;
  }

  /**
   * @param offsetMs estimated delay gradient m_hat
   * @param timestampMs sample time
   */
  detect(offsetMs: number, timestampMs: number): BandwidthUsage {
    if (this.lastUpdateMs === 0) {
      this.lastUpdateMs = timestampMs;
    }
    const T = this.thresholdMs;

    if (offsetMs > T) {
      if (this.timeOverUsingMs === -1) {
        this.timeOverUsingMs = 0;
      } else {
        this.timeOverUsingMs += timestampMs - this.lastUpdateMs;
      }
      this.overuseCounter++;
      // Definitive over-use only if sustained and offset not decreasing.
      if (
        this.timeOverUsingMs > kOveruseTimeThresholdMs &&
        this.overuseCounter > 1 &&
        offsetMs >= this.prevOffsetMs
      ) {
        this.timeOverUsingMs = 0;
        this.overuseCounter = 0;
        this.hypothesis = "overuse";
      }
    } else if (offsetMs < -T) {
      this.timeOverUsingMs = -1;
      this.overuseCounter = 0;
      this.hypothesis = "underuse";
    } else {
      this.timeOverUsingMs = -1;
      this.overuseCounter = 0;
      this.hypothesis = "normal";
    }

    this.updateThreshold(offsetMs, timestampMs);
    this.prevOffsetMs = offsetMs;
    this.lastUpdateMs = timestampMs;
    return this.hypothesis;
  }

  private updateThreshold(offsetMs: number, timestampMs: number) {
    if (this.lastUpdateMs === 0) return;
    if (Math.abs(offsetMs) - this.thresholdMs > kMaxAdaptOffsetMs) {
      // Skip adaptation on large spikes (draft).
      return;
    }
    const dt = Math.min(timestampMs - this.lastUpdateMs, 100);
    const k =
      Math.abs(offsetMs) < this.thresholdMs
        ? kThresholdGainDown
        : kThresholdGainUp;
    this.thresholdMs =
      this.thresholdMs + dt * k * (Math.abs(offsetMs) - this.thresholdMs);
    this.thresholdMs = Math.min(
      Math.max(this.thresholdMs, kMinThresholdMs),
      kMaxThresholdMs,
    );
  }
}

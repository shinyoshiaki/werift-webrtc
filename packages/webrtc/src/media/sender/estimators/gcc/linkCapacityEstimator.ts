/**
 * libwebrtc `LinkCapacityEstimator` (pin goog_cc/link_capacity_estimator).
 * Used by AimdRateControl to choose additive vs multiplicative increase and
 * to refine overuse decreases.
 */
export class LinkCapacityEstimator {
  private estimateKbps: number | undefined;
  private deviationKbps = 0.4;

  reset() {
    this.estimateKbps = undefined;
    this.deviationKbps = 0.4;
  }

  hasEstimate(): boolean {
    return this.estimateKbps !== undefined;
  }

  /** Estimated capacity in bps. */
  estimateBps(): number {
    return Math.round((this.estimateKbps ?? 0) * 1000);
  }

  /** Upper bound bps (estimate + 3σ), or +∞ if unknown. */
  upperBoundBps(): number {
    if (this.estimateKbps === undefined) {
      return Number.POSITIVE_INFINITY;
    }
    return Math.round((this.estimateKbps + 3 * this.deviationEstimateKbps()) * 1000);
  }

  /** Lower bound bps (estimate − 3σ), or 0 if unknown. */
  lowerBoundBps(): number {
    if (this.estimateKbps === undefined) {
      return 0;
    }
    return Math.round(
      Math.max(0, this.estimateKbps - 3 * this.deviationEstimateKbps()) * 1000,
    );
  }

  onOveruseDetected(acknowledgedRateBps: number) {
    this.update(acknowledgedRateBps, 0.05);
  }

  onProbeRate(probeRateBps: number) {
    this.update(probeRateBps, 0.5);
  }

  private update(capacitySampleBps: number, alpha: number) {
    const sampleKbps = capacitySampleBps / 1000;
    if (this.estimateKbps === undefined) {
      this.estimateKbps = sampleKbps;
    } else {
      this.estimateKbps = (1 - alpha) * this.estimateKbps + alpha * sampleKbps;
    }
    const norm = Math.max(this.estimateKbps, 1.0);
    const errorKbps = this.estimateKbps - sampleKbps;
    this.deviationKbps =
      (1 - alpha) * this.deviationKbps +
      (alpha * errorKbps * errorKbps) / norm;
    // 0.4 ~= 14 kbit/s at 500 kbit/s; 2.5 ~= 35 kbit/s at 500 kbit/s
    this.deviationKbps = Math.min(2.5, Math.max(0.4, this.deviationKbps));
  }

  private deviationEstimateKbps(): number {
    return Math.sqrt(this.deviationKbps * (this.estimateKbps ?? 0));
  }
}

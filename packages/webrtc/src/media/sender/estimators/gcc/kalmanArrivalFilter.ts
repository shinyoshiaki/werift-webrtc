import {
  kKalmanInitialErrorCovariance,
  kKalmanProcessNoise,
  kMeasurementNoiseChi,
} from "./constants";

/**
 * Scalar Kalman arrival-time filter (draft-ietf-rmcat-gcc-02 §5.3).
 * Estimates inter-group delay variation mean m_hat from samples d(i).
 */
export class KalmanArrivalFilter {
  private mHat = 0;
  private errorCov = kKalmanInitialErrorCovariance;
  private varVHat = 1;
  private lastUpdateMs = 0;

  reset() {
    this.mHat = 0;
    this.errorCov = kKalmanInitialErrorCovariance;
    this.varVHat = 1;
    this.lastUpdateMs = 0;
  }

  /**
   * @param delayGradientMs inter-group delay variation d(i) in ms
   * @param nowMs wall clock for sampling-rate adaptation
   * @returns updated m_hat (ms)
   */
  update(delayGradientMs: number, nowMs: number): number {
    const q = kKalmanProcessNoise;
    const z = delayGradientMs - this.mHat;

    // Outlier-clamped residual for noise variance update (draft §5.3).
    const threeSigma = 3 * Math.sqrt(Math.max(this.varVHat, 1e-6));
    const zForVar = Math.abs(z) > threeSigma ? Math.sign(z) * threeSigma : z;

    let fMax = 30; // groups/s fallback
    if (this.lastUpdateMs > 0) {
      const dt = Math.max(nowMs - this.lastUpdateMs, 1);
      fMax = Math.max(1000 / dt, 1);
    }
    this.lastUpdateMs = nowMs;

    const alpha = (1 - kMeasurementNoiseChi) ** (30 / (1000 * fMax));
    this.varVHat = Math.max(alpha * this.varVHat + (1 - alpha) * zForVar ** 2, 1);

    const predErr = this.errorCov + q;
    const k = predErr / (this.varVHat + predErr);
    this.mHat = this.mHat + z * k;
    this.errorCov = (1 - k) * predErr;

    return this.mHat;
  }

  get estimateMs() {
    return this.mHat;
  }
}

/**
 * Backward-compatible entry for the default (legacy) send-side BWE.
 *
 * Prefer importing {@link BandwidthEstimator}, {@link SenderBandwidthEstimator},
 * or {@link GccBandwidthEstimator} from the package root / media exports.
 */
export type { BandwidthEstimator, SentInfo } from "./bandwidthEstimator";
export {
  LegacyCumulativeBandwidthEstimator,
  SenderBandwidthEstimator,
} from "./estimators/legacyCumulativeBwe";

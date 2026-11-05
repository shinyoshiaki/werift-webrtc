/**
 * Backward-compatible entry for the default (lightweight) send-side BWE.
 *
 * Prefer importing {@link BandwidthEstimator}, {@link LightweightBandwidthEstimator},
 * or {@link GccBandwidthEstimator} from the package root / media exports.
 */
export type { BandwidthEstimator, SentInfo } from "./bandwidthEstimator";
export {
  isLightweightBandwidthEstimator,
  LightweightBandwidthEstimator,
  SenderBandwidthEstimator,
} from "./estimators/lightweightBwe";

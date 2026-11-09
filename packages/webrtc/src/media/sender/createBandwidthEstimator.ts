import type { BandwidthEstimator } from "./bandwidthEstimator";
import { DisabledBandwidthEstimator } from "./estimators/disabledBwe";
import { GccBandwidthEstimator } from "./estimators/gcc/gccBwe";
import { LightweightBandwidthEstimator } from "./estimators/lightweightBwe";

/**
 * Named presets for {@link PeerConfig.bandwidthEstimator}.
 * `"lightweight"` is the default (the existing estimator, backward compatible).
 */
export type BandwidthEstimatorPreset = "lightweight" | "gcc" | "none";

/**
 * How a new {@link RTCRtpSender} obtains its {@link BandwidthEstimator}.
 *
 * - `"lightweight"` (default): {@link LightweightBandwidthEstimator}
 * - `"gcc"`: {@link GccBandwidthEstimator}
 * - `false` / `"none"`: {@link DisabledBandwidthEstimator}
 * - factory: called **once per sender** (do not share one instance)
 */
export type BandwidthEstimatorOption =
  | BandwidthEstimatorPreset
  | false
  | (() => BandwidthEstimator);

/**
 * Construct a send-side estimator from a {@link BandwidthEstimatorOption}.
 * Each {@link RTCRtpSender} must get its own instance.
 */
export function createBandwidthEstimator(
  option: BandwidthEstimatorOption | undefined = "lightweight",
): BandwidthEstimator {
  if (option === undefined || option === "lightweight") {
    return new LightweightBandwidthEstimator();
  }
  if (option === false || option === "none") {
    return new DisabledBandwidthEstimator();
  }
  if (option === "gcc") {
    return new GccBandwidthEstimator();
  }
  if (typeof option === "function") {
    return option();
  }
  throw new TypeError(
    `unsupported bandwidthEstimator option: ${String(option)}`,
  );
}

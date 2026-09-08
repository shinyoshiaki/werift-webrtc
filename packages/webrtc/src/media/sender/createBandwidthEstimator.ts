import type { BandwidthEstimator } from "./bandwidthEstimator";
import { DisabledBandwidthEstimator } from "./estimators/disabledBwe";
import { GccBandwidthEstimator } from "./estimators/gcc/gccBwe";
import { SenderBandwidthEstimator } from "./estimators/legacyCumulativeBwe";

/**
 * Named presets for {@link PeerConfig.bandwidthEstimator}.
 * `"legacy"` is the default (backward compatible).
 */
export type BandwidthEstimatorPreset = "legacy" | "gcc" | "none";

/**
 * How a new {@link RTCRtpSender} obtains its {@link BandwidthEstimator}.
 *
 * - `"legacy"` (default): {@link SenderBandwidthEstimator}
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
  option: BandwidthEstimatorOption | undefined = "legacy",
): BandwidthEstimator {
  if (option === undefined || option === "legacy") {
    return new SenderBandwidthEstimator();
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

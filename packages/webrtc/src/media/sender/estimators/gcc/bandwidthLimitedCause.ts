import {
  kLossLimitedProbeScale,
  kMaxBitrateBps,
  kRttBasedBackOffHighRttMs,
} from "./constants";
import type { LossBasedState } from "./lossBasedBwe";
import type { BandwidthUsage } from "./overuseDetector";

/**
 * libwebrtc `BandwidthLimitedCause` (probe_controller.h) — reason the BWE
 * estimate is limited. ProbeController::InitiateProbing uses this to decide
 * whether new probes are forbidden or allowed with a scale cap.
 */
export type BandwidthLimitedCause =
  | "loss_limited_bwe_increasing"
  | "loss_limited_bwe"
  | "delay_based_limited"
  | "delay_based_limited_delay_increased"
  | "rtt_based_back_off_high_rtt";

/**
 * libwebrtc `GetBandwidthLimitedCause` (goog_cc_network_control.cc).
 *
 * | Delay usage | RTT high? | LossBasedState | Cause |
 * | overuse/underuse | * | * | delay_based_limited_delay_increased |
 * | normal | yes | * | rtt_based_back_off_high_rtt |
 * | normal | no | decreasing / hold / padding | loss_limited_bwe |
 * | normal | no | increasing | loss_limited_bwe_increasing |
 * | normal | no | delay_based | delay_based_limited |
 *
 * Note: werift folds `kIncreaseUsingPadding` into `increasing` for rate
 * control, but keeps a separate `hold` state that still maps to the forbid
 * cause (`kLossLimitedBwe`) — same InitiateProbing outcome as pin.
 */
export function getBandwidthLimitedCause(
  usage: BandwidthUsage,
  isRttAboveLimit: boolean,
  lossState: LossBasedState,
): BandwidthLimitedCause {
  if (usage === "overuse" || usage === "underuse") {
    return "delay_based_limited_delay_increased";
  }
  if (isRttAboveLimit) {
    return "rtt_based_back_off_high_rtt";
  }
  switch (lossState) {
    case "decreasing":
    case "hold":
      return "loss_limited_bwe";
    case "increasing":
      return "loss_limited_bwe_increasing";
    case "delay_based":
      return "delay_based_limited";
  }
}

/** True when InitiateProbing would return a non-empty cluster list. */
export function isProbeInitiationAllowed(
  cause: BandwidthLimitedCause,
): boolean {
  return (
    cause === "loss_limited_bwe_increasing" || cause === "delay_based_limited"
  );
}

/**
 * Max probe target bitrate for this cause (libwebrtc InitiateProbing switch).
 * - kLossLimitedBweIncreasing → estimated × loss_limited_probe_scale (1.5)
 * - kDelayBasedLimited → no extra cap (only configured max)
 * - forbid causes → 0 (caller should not probe)
 */
export function maxProbeBitrateBps(
  cause: BandwidthLimitedCause,
  estimatedBitrateBps: number,
  configuredMaxBps = kMaxBitrateBps,
): number {
  if (!isProbeInitiationAllowed(cause)) {
    return 0;
  }
  let max = configuredMaxBps;
  if (cause === "loss_limited_bwe_increasing") {
    max = Math.min(
      max,
      Math.max(0, estimatedBitrateBps) * kLossLimitedProbeScale,
    );
  }
  return max;
}

/**
 * RTT above libwebrtc RttBasedBackoff default limit (3s).
 * Call with **CorrectedRtt / propagation RTT** (not raw max feedback RTT).
 * Prefer {@link RttBasedBackoff.isRttAboveLimit} when the helper is available.
 */
export function isRttAboveLimit(
  rttMs: number,
  limitMs = kRttBasedBackOffHighRttMs,
): boolean {
  return Number.isFinite(rttMs) && rttMs > limitMs;
}

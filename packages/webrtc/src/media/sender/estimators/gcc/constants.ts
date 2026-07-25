/**
 * Named constants for Google Congestion Control (GCC).
 *
 * Primary sources:
 * - draft-ietf-rmcat-gcc-02 (RECOMMENDED table values)
 * - libwebrtc `modules/congestion_controller/goog_cc` (runtime defaults when they diverge)
 *
 * Known intentional differences from libwebrtc C++ are listed in
 * {@link GCC_KNOWN_DIFFERENCES}.
 */

/** Initial / fallback start bitrate (libwebrtc-style default ~300 kbps). */
export const kDefaultStartBitrateBps = 300_000;

/** Minimum target bitrate clamp. */
export const kMinBitrateBps = 10_000;

/** Maximum target bitrate clamp (1 Gbps, matches libwebrtc-ish upper bound). */
export const kMaxBitrateBps = 1_000_000_000;

/** Burst grouping window for inter-arrival pre-filter (draft burst_time). */
export const kBurstTimeMs = 5;

/** Kalman state noise variance q (draft RECOMMENDED 1e-3). */
export const kKalmanProcessNoise = 1e-3;

/** Initial Kalman system error covariance e(0). */
export const kKalmanInitialErrorCovariance = 0.1;

/** Chi for measurement-noise variance EMA (draft interval mid-ish). */
export const kMeasurementNoiseChi = 0.01;

/** Initial adaptive overuse threshold del_var_th(0) in ms. */
export const kInitialThresholdMs = 12.5;

/** Minimum / maximum adaptive threshold clamp (draft). */
export const kMinThresholdMs = 6;
export const kMaxThresholdMs = 600;

/** Time the delay gradient must stay above threshold to declare overuse. */
export const kOveruseTimeThresholdMs = 10;

/** Adaptive threshold increase / decrease gains (draft K_u / K_d). */
export const kThresholdGainUp = 0.01;
export const kThresholdGainDown = 0.00018;

/** Skip threshold adaptation when |m| - thr is this large (draft). */
export const kMaxAdaptOffsetMs = 15;

/** AIMD decrease factor beta (draft RECOMMENDED 0.85). */
export const kBeta = 0.85;

/** Multiplicative increase base per second (draft ~8%/s → 1.08). */
export const kMultiplicativeIncreaseFactor = 1.08;

/** Additive increase uses half a packet per response-time interval. */
export const kAdditiveIncreaseFactor = 0.5;

/** Extra reaction time added to RTT for AIMD additive increase (ms). */
export const kReactionTimeMs = 100;

/** Window for measuring received bitrate R_hat (ms). */
export const kBitrateWindowMs = 1000;

/** Default RTT assumption when unknown (ms). */
export const kDefaultRttMs = 100;

/** Loss-based: increase when loss fraction is below this. */
export const kLossIncreaseThreshold = 0.02;

/** Loss-based: hold when loss fraction is between increase and decrease. */
export const kLossDecreaseThreshold = 0.1;

/** Loss-based multiplicative increase when loss is low. */
export const kLossIncreaseFactor = 1.05;

/** Probe: initial exploration multiples of current target (libwebrtc-like). */
export const kProbeBitrateMultipliers = [3, 6] as const;

/** Probe cluster minimum duration (ms). */
export const kProbeMinDurationMs = 15;

/** Probe cluster minimum number of packets. */
export const kProbeMinPackets = 5;

/** After a successful probe, cooldown before next exploratory probe (ms). */
export const kProbeCooldownMs = 5000;

/** Maximum age of sent-info history retained for TWCC matching (ms). */
export const kSentInfoMaxAgeMs = 10_000;

/**
 * Documented intentional differences vs Chromium/libwebrtc goog_cc.
 *
 * - Pure TypeScript: no bit-identical floating point / timing with C++.
 * - Arrival-time filter uses the draft Kalman scalar form rather than the
 *   newer libwebrtc TrendlineEstimator (same delay-based role; structure of
 *   overuse → AIMD → min(delay, loss) matches both).
 * - Loss-based controller follows draft §6 (2% / 10% thresholds), not
 *   LossBasedBweV2 state machine in modern libwebrtc.
 * - Probe controller is a compact send-side probe estimator driven by
 *   TWCC + `SentInfo.isProbation`; it does not drive a separate pacer API
 *   (applications may raise encoder rate toward `availableBitrate` / probe target).
 * - REMB input path is not wired (TWCC-only send-side mode).
 */
export const GCC_KNOWN_DIFFERENCES = [
  "Kalman arrival-time filter (draft) instead of libwebrtc TrendlineEstimator",
  "Loss-based uses draft §6 thresholds, not LossBasedBweV2",
  "No REMB integration; TWCC feedback path only",
  "Probe does not control a native pacer; probe clusters inferred from sent/feedback",
  "Numerical results may differ slightly due to language/time-source differences",
] as const;

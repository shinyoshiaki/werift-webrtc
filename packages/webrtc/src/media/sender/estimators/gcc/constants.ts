/**
 * Named constants for Google Congestion Control (GCC).
 *
 * Prefer **libwebrtc goog_cc** runtime defaults when draft-ietf-rmcat-gcc and
 * Chromium diverge.
 *
 * Known intentional differences: {@link GCC_KNOWN_DIFFERENCES}.
 */

/** Initial / fallback start bitrate (libwebrtc default ~300 kbps). */
export const kDefaultStartBitrateBps = 300_000;

export const kMinBitrateBps = 10_000;
export const kMaxBitrateBps = 1_000_000_000;

/** Burst grouping window for inter-arrival pre-filter (ms). */
export const kBurstTimeMs = 5;

// --- TrendlineEstimator (libwebrtc trendline_estimator.cc) ---

/**
 * Default window size in packets
 * (`TrendlineEstimatorSettings::kDefaultTrendlineWindowSize` = 20).
 * Slope is only recomputed when the window is full.
 */
export const kTrendlineWindowSize = 20;

/** Exponential smoothing coefficient for accumulated delay. */
export const kTrendlineSmoothingCoeff = 0.9;

/**
 * Gain applied as `min(num_deltas, kMinNumDeltas) * trend * gain`
 * before comparing to the adaptive threshold.
 */
export const kTrendlineThresholdGain = 4.0;

/**
 * Cap used in modified_trend: `min(num_of_deltas, kMinNumDeltas)`.
 * libwebrtc: kMinNumDeltas = 60.
 */
export const kTrendlineMinNumDeltas = 60;

/** libwebrtc caps num_of_deltas_ at this value. */
export const kTrendlineDeltaCounterMax = 1000;

// --- Overuse detector (libwebrtc TrendlineEstimator::Detect / UpdateThreshold) ---

export const kInitialThresholdMs = 12.5;
export const kMinThresholdMs = 6;
export const kMaxThresholdMs = 600;
export const kOveruseTimeThresholdMs = 10;

/** libwebrtc k_up_ / k_down_ for adaptive threshold (not draft K_u / K_d). */
export const kThresholdGainUp = 0.0087;
export const kThresholdGainDown = 0.039;

export const kMaxAdaptOffsetMs = 15;

// --- AIMD ---

export const kBeta = 0.85;
export const kMultiplicativeIncreaseFactor = 1.08;
export const kAdditiveIncreaseFactor = 0.5;
export const kReactionTimeMs = 100;
export const kBitrateWindowMs = 1000;
export const kDefaultRttMs = 100;

// --- Loss-based ---

export const kLossIncreaseThreshold = 0.02;
export const kLossDecreaseThreshold = 0.1;
export const kLossBasedIncreaseFactor = 1.05;
export const kLossBasedBackoffFactor = 0.5;
export const kLossIncreaseFactor = kLossBasedIncreaseFactor;

// --- ProbeController ---

export const kProbeBitrateMultipliers = [3, 6] as const;
export const kFurtherProbeThreshold = 0.7;
export const kProbeMinDurationMs = 15;
export const kProbeMinPackets = 5;
export const kProbeResultTimeoutMs = 1000;

/**
 * Max padding packet payload size when RTCRtpSender injects probe padding
 * (libwebrtc uses padding to fill probe clusters when media is sparse).
 */
export const kProbePaddingPacketBytes = 256;

/** Max probe padding packets emitted per sendRtp / maybeSendProbePadding call. */
export const kProbePaddingMaxBurst = 8;

export const kSentInfoMaxAgeMs = 10_000;

/**
 * Intentional differences vs Chromium/libwebrtc goog_cc.
 *
 * - Pure TypeScript: not bit-identical floating point / timing with C++.
 * - LossBasedBweV2 full candidate mesh simplified to threshold/state form.
 * - No REMB integration (TWCC-only send-side mode).
 * - Pacer is a lightweight token-bucket + padding injection on RTCRtpSender,
 *   not webrtc::PacedSender / PacketRouter.
 */
export const GCC_KNOWN_DIFFERENCES = [
  "LossBasedBwe uses libwebrtc-aligned thresholds/states, not full LossBasedBweV2 candidate enumeration",
  "No REMB integration; TWCC feedback path only",
  "RTCRtpSender injects RTP padding for probe clusters when media is sparse (simplified vs webrtc pacer)",
  "Numerical results may differ slightly due to language/time-source differences",
] as const;

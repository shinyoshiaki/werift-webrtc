/**
 * Named constants for Google Congestion Control (GCC).
 *
 * Prefer **libwebrtc goog_cc** runtime defaults when draft-ietf-rmcat-gcc and
 * Chromium diverge. Draft values are retained only where still used by
 * libwebrtc (e.g. overuse threshold adaptation).
 *
 * Known intentional differences: {@link GCC_KNOWN_DIFFERENCES}.
 */

/** Initial / fallback start bitrate (libwebrtc default ~300 kbps). */
export const kDefaultStartBitrateBps = 300_000;

/** Minimum target bitrate clamp. */
export const kMinBitrateBps = 10_000;

/** Maximum target bitrate clamp. */
export const kMaxBitrateBps = 1_000_000_000;

/** Burst grouping window for inter-arrival pre-filter (ms). */
export const kBurstTimeMs = 5;

// --- TrendlineEstimator (libwebrtc) ---

/** Sliding window size for trendline samples. */
export const kTrendlineWindowSize = 20;

/** Exponential smoothing coefficient for accumulated delay. */
export const kTrendlineSmoothingCoeff = 0.9;

/** Gain applied to regression slope before overuse detection. */
export const kTrendlineThresholdGain = 4.0;

// --- Overuse detector (shared with draft / libwebrtc) ---

export const kInitialThresholdMs = 12.5;
export const kMinThresholdMs = 6;
export const kMaxThresholdMs = 600;
export const kOveruseTimeThresholdMs = 10;
export const kThresholdGainUp = 0.01;
export const kThresholdGainDown = 0.00018;
export const kMaxAdaptOffsetMs = 15;

// --- AIMD ---

export const kBeta = 0.85;
export const kMultiplicativeIncreaseFactor = 1.08;
export const kAdditiveIncreaseFactor = 0.5;
export const kReactionTimeMs = 100;
export const kBitrateWindowMs = 1000;
export const kDefaultRttMs = 100;

// --- Loss-based (libwebrtc operational thresholds) ---

/** Increase when observed loss is below this (≈2%). */
export const kLossIncreaseThreshold = 0.02;

/** Decrease when observed loss is above this (≈10%). */
export const kLossDecreaseThreshold = 0.1;

/** Multiplicative increase when loss is low. */
export const kLossBasedIncreaseFactor = 1.05;

/** Backoff coefficient applied as ack * (1 - factor * p) on high loss. */
export const kLossBasedBackoffFactor = 0.5;

/** @deprecated use kLossBasedIncreaseFactor — kept for test import compatibility. */
export const kLossIncreaseFactor = kLossBasedIncreaseFactor;

// --- ProbeController (libwebrtc scales) ---

/** First/second exponential probe scales of start bitrate. */
export const kProbeBitrateMultipliers = [3, 6] as const;

/** Further probe when estimate exceeds this × last probe target. */
export const kFurtherProbeThreshold = 0.7;

export const kProbeMinDurationMs = 15;
export const kProbeMinPackets = 5;

/** Drop active probe cluster if results do not complete in time. */
export const kProbeResultTimeoutMs = 1000;

/** Maximum age of sent-info history retained for TWCC matching (ms). */
export const kSentInfoMaxAgeMs = 10_000;

/**
 * Intentional differences vs Chromium/libwebrtc goog_cc (still tracked).
 *
 * - Pure TypeScript: not bit-identical floating point / timing with C++.
 * - LossBasedBweV2 full candidate mesh is simplified to threshold/state form
 *   with the same low/high loss control response used operationally with TWCC.
 * - No REMB integration (TWCC-only send-side mode).
 * - Pacer is a lightweight token-bucket on RTCRtpSender, not webrtc::PacedSender.
 */
export const GCC_KNOWN_DIFFERENCES = [
  "LossBasedBwe uses libwebrtc-aligned thresholds/states, not full LossBasedBweV2 candidate enumeration",
  "No REMB integration; TWCC feedback path only",
  "RTCRtpSender uses a lightweight token-bucket pacer for probe targets (not webrtc::PacedSender)",
  "Numerical results may differ slightly due to language/time-source differences",
] as const;

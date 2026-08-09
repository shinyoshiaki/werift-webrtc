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

// --- Loss-based (libwebrtc LossBasedBweV2 field-trial defaults, lkgr) ---

/** ObservationWindowSize default 15. */
export const kLossBasedObservationWindow = 15;

/**
 * Min observation duration before a partial window is committed (ms).
 * libwebrtc `ObservationDurationLowerBound` default 250ms.
 */
export const kLossBasedObservationDurationLowerBoundMs = 250;

/**
 * Min committed observations before estimates are used.
 * libwebrtc readiness uses delayed start after several observations (3).
 */
export const kLossBasedMinNumObservations = 3;

/** CandidateFactors default {1.02, 1.0, 0.95}. */
export const kLossBasedCandidateFactors = [1.02, 1.0, 0.95] as const;

export const kLossBasedInherentLossLowerBound = 1e-3;
export const kLossBasedInherentLossUpperBoundOffset = 0.05;
/** InherentLossUpperBoundBwBalance default 100 kbps. */
export const kLossBasedInherentLossUpperBoundBwBalanceBps = 100_000;
export const kLossBasedInitialInherentLoss = 0.01;
export const kLossBasedNewtonIterations = 1;
/** NewtonStepSize default 0.75. */
export const kLossBasedNewtonStepSize = 0.75;
/** HigherBandwidthBiasFactor default 0.0002. */
export const kLossBasedHigherBwBiasFactor = 0.0002;
/** HigherLogBandwidthBiasFactor default 0.02. */
export const kLossBasedHigherLogBwBiasFactor = 0.02;
/** TemporalWeightFactor default 0.9. */
export const kLossBasedTemporalWeightFactor = 0.9;
/** BwRampupUpperBoundFactor default 1.5. */
export const kLossBasedRampupUpperBoundFactor = 1.5;

/**
 * UseByteLossRate default true — objective/derivative use lost/received **bytes**.
 */
export const kLossBasedUseByteLossRate = true;

/** LossThresholdOfHighBandwidthPreference default 0.2. */
export const kLossBasedLossThresholdOfHighBandwidthPreference = 0.2;
/** BandwidthPreferenceSmoothingFactor default 0.002. */
export const kLossBasedBandwidthPreferenceSmoothingFactor = 0.002;

/** InstantUpperBoundBwBalance default 100 kbps. */
export const kLossBasedInstantUpperBoundBwBalanceBps = 100_000;
/** InstantUpperBoundLossOffset default 0.05. */
export const kLossBasedInstantUpperBoundLossOffset = 0.05;
/** InstantUpperBoundTemporalWeightFactor default 0.9. */
export const kLossBasedInstantUpperBoundTemporalWeightFactor = 0.9;

/** LowerBoundByAckedRateFactor default 1.0. */
export const kLossBasedLowerBoundByAckedRateFactor = 1.0;

/** DelayedIncreaseWindow default 300ms. */
export const kLossBasedDelayedIncreaseWindowMs = 300;
/** MaxIncreaseFactor default 1.3. */
export const kLossBasedMaxIncreaseFactor = 1.3;

/** HoldDurationFactor default 3.0 in some builds; field trial default 2.0. */
export const kLossBasedHoldDurationFactor = 2.0;
/** Initial HOLD duration (ms). libwebrtc kInitHoldDuration = 300ms. */
export const kLossBasedInitHoldDurationMs = 300;
/** Max HOLD duration (ms). libwebrtc kMaxHoldDuration = 60s. */
export const kLossBasedMaxHoldDurationMs = 60_000;

/** BoundBestCandidate default true. */
export const kLossBasedBoundBestCandidate = true;
/** NotIncreaseIfInherentLossLessThanAverageLoss default true. */
export const kLossBasedNotIncreaseIfInherentLessThanAverage = true;

/** Legacy names kept for tests. */
export const kLossIncreaseThreshold = 0.02;
export const kLossDecreaseThreshold = 0.1;
export const kLossBasedIncreaseFactor = 1.02;
export const kLossBasedBackoffFactor = 0.5;
export const kLossIncreaseFactor = kLossBasedIncreaseFactor;

// --- ProbeController ---

/** Initial exponential probe steps: start×3, start×6. */
export const kProbeBitrateMultipliers = [3, 6] as const;
/** Further probes after success use ×2 (libwebrtc further probe step). */
export const kFurtherProbeStepMultiplier = 2;
export const kFurtherProbeThreshold = 0.7;
export const kProbeMinDurationMs = 15;
export const kProbeMinPackets = 5;
export const kProbeResultTimeoutMs = 1000;

/**
 * RTP padding size (bytes) when RTCRtpSender injects probe padding.
 * Must fit in a single octet (RFC 3550 last padding byte = length), so ≤255.
 */
export const kProbePaddingPacketBytes = 224;

/**
 * Max probe padding packets per inner burst (outer loop drains remaining).
 * Keeps event-loop responsive while still completing large clusters.
 */
export const kProbePaddingMaxBurst = 16;

export const kSentInfoMaxAgeMs = 10_000;

/**
 * Intentional differences vs Chromium libwebrtc goog_cc.
 * Acceptable under the ticket's pure-TypeScript / no C++ binding constraint;
 * algorithm structure and control response match the reference.
 */
export const GCC_KNOWN_DIFFERENCES = [
  "LossBasedBweV2: byte-loss objective/derivative (UseByteLossRate), bias adjustment by loss ratio, instant upper/lower bounds, delayed-increase window, HOLD rate; full ALR/padding-duration state machine simplified (IncreaseUsingPadding collapsed into increasing when padding path is unused)",
  "No REMB integration; TWCC-only send-side mode (ticket non-goal)",
  "Probe pacing uses RTCRtpSender token-bucket + RTP padding injection (not webrtc::PacedSender); initial 3x/6x clusters are multi-active (pacing target = max active)",
  "Floating-point / wall-clock differences may cause sub-bps numerical drift vs C++",
  "InterArrivalDelta: reordered-reset / arrival-offset thresholds ported; system-clock path omitted (TWCC receive times only)",
] as const;

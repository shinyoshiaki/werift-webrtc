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

// --- AIMD (libwebrtc AimdRateControl) ---

/** Multiplicative decrease factor (libwebrtc beta ≈ 0.85). */
export const kBeta = 0.85;
/** Multiplicative increase base per second (≈ 1.08). */
export const kMultiplicativeIncreaseFactor = 1.08;
/** Additive increase scale (packets per response-time unit). */
export const kAdditiveIncreaseFactor = 0.5;
/** Extra delay added to RTT for additive response time. */
export const kReactionTimeMs = 100;
export const kBitrateWindowMs = 1000;
export const kDefaultRttMs = 100;
/**
 * Allow another decrease before RTT elapses when acked throughput falls
 * below this fraction of the current estimate (libwebrtc-style throughput check).
 */
export const kThroughputLowerFraction = 0.5;

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
 * When acknowledged rate has not yet recovered past holdRate × threshold,
 * use a more cautious ramp-up (libwebrtc BwRampupUpperBoundInHoldFactor).
 */
export const kLossBasedRampupUpperBoundInHoldFactor = 1.2;
/** BwRampupUpperBoundHoldThreshold default 1.3. */
export const kLossBasedRampupUpperBoundHoldThreshold = 1.3;

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
/**
 * BitrateProber pacing-cluster timeout (ms).
 * A cluster that never reaches send-fill is dropped after this (libwebrtc ≈ 5s).
 */
export const kProbePacingTimeoutMs = 5_000;
/**
 * ProbeController result-wait timeout (ms).
 * After send-fill, waiting for TWCC/result validation uses this (libwebrtc ≈ 1s).
 * Also used as ProbeBitrateEstimator cluster history horizon.
 */
export const kProbeResultTimeoutMs = 1_000;
/** libwebrtc ProbeBitrateEstimator: min % of probes that must be ACKed. */
export const kProbeMinReceivedProbesPercent = 80;
/** libwebrtc ProbeBitrateEstimator: min % of bytes that must be ACKed. */
export const kProbeMinReceivedBytesPercent = 80;
/** Reject estimate if receive/send rate ratio exceeds this. */
export const kProbeMaxValidRatio = 2.0;
/** If receive < this × send, treat link as capacity-limited. */
export const kProbeMinRatioForUnsaturated = 0.9;
/** Target utilization when capacity-limited (slightly under receive rate). */
export const kProbeTargetUtilization = 0.95;
/** Max send/receive interval for a valid probe cluster (ms). */
export const kProbeMaxIntervalMs = 1000;
/**
 * Min interval between recovery / further probe sessions (ms).
 * Prevents continuous underuse-triggered padding from re-congesting the link
 * after the estimate has settled near capacity.
 */
export const kProbeMinIntervalMs = 5_000;
/** Recovery probe scale relative to current estimate only (not start bitrate). */
export const kProbeRecoveryScale = 1.5;
/** Cap recovery probe at this multiple of current estimate. */
export const kProbeRecoveryMaxScale = 2.0;
/**
 * Abort active probe clusters when batch loss fraction reaches this
 * (libwebrtc stops probing under clear congestion).
 */
export const kProbeAbortLossFraction = 0.05;
/**
 * Recovery-phase only: do not accept a probe result more than this multiple
 * of the current delay/loss target. **Not applied during initial exponential
 * probing** (×3/×6 must be able to raise the estimate well above start).
 */
export const kProbeResultMaxOverTarget = 1.5;
/**
 * Soft ceiling vs recent acked bitrate when acked > 0 (both initial and recovery).
 * Filters multi-fold outliers from a single short TWCC window.
 */
export const kProbeResultMaxOverAcked = 2.0;
/**
 * libwebrtc kProbeDropThroughputFraction: when a valid probe result is **below**
 * the current BWE, floor the applied value at acked×this so a single glitchy
 * probe cannot crash the estimate far below observed throughput. Still allows
 * a modest drop to drain queues when truly overusing.
 */
export const kProbeDropThroughputFraction = 0.85;

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
  "LossBasedBweV2: byte-loss objective/derivative (UseByteLossRate), bias adjustment by loss ratio, instant upper/lower bounds, delayed-increase window, HOLD (state stays decreasing while holdUntil active; ramp-up 1.2× when acked still below hold×1.3 else 1.5×); full ALR/padding-duration state machine simplified (IncreaseUsingPadding collapsed into increasing when padding path is unused)",
  "No REMB integration; TWCC-only send-side mode (ticket non-goal; future work)",
  "Probe pacing uses RTCRtpSender token-bucket + RTP padding injection (not webrtc::PacedSender); 3x/6x queued FIFO — pacing advances on send-fill (minBytes AND minPackets), not on ACK; result clusters await TWCC separately; session complete deferred to process() so last-cluster setEstimatedBitrate can still enqueue further probes; when uncapped further/recovery target would exceed max_bitrate, one last max probe then min_bitrate_to_probe_further=+inf (no infinite max-bitrate padding); lifecycle/timeout/cooldown use sender clock only; onProbeClusterConfig fires on activate only; ProbeBitrateEstimator receive % / ratio checks; valid results always surfaced (lower probes floored at acked×0.85); recovery + 5s cooldown; abort on loss≥5% or overuse; no ALR-only probe path",
  "AIMD: TimeToReduceFurther (RTT spacing + throughput check) and hold-after-decrease ported; RTT is estimated from feedback arrival − last send (not full ICE/STUN RTT stats / NetworkController RTT)",
  "TWCC 24-bit reference_time is unwrapped across feedbacks in GccBandwidthEstimator (continuous ms timeline); packetResults alone still report raw wrap-relative times; ReceiverTWCC late-reorder history is ~500ms (time-based) with a sequence safety bound",
  "Floating-point / wall-clock differences may cause sub-bps numerical drift vs C++ (not bit-identical to libwebrtc public test vectors)",
  "InterArrivalDelta: reordered-reset / arrival-offset thresholds ported; system-clock path omitted (TWCC receive times only)",
  "Transport-wide sequence is shared on the DTLS transport while BWE instances are per RTCRtpSender (ticket constraint; multi-sender asymmetry is intentional)",
] as const;

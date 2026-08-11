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

// --- Acknowledged bitrate (libwebrtc RobustThroughputEstimator defaults) ---
// Pin: RobustThroughputEstimatorSettings.enabled = true

/** Min packets to form a window (window_packets = 20). */
export const kRobustWindowPackets = 20;
/** Hard cap on packets retained (max_window_packets = 500). */
export const kRobustMaxWindowPackets = 500;
/** Min window duration once packet count is met (min_window_duration = 1s). */
export const kRobustMinWindowDurationMs = 1000;
/** Max window duration (max_window_duration = 5s). */
export const kRobustMaxWindowDurationMs = 5000;
/** Min packets before producing an estimate (required_packets = 10). */
export const kRobustRequiredPackets = 10;

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
 * Recovery is requested only on underuse → normal (not while still underusing);
 * this cooldown still spaces further/recovery sessions near capacity.
 */
export const kProbeMinIntervalMs = 5_000;
/** Recovery probe scale relative to current estimate only (not start bitrate). */
export const kProbeRecoveryScale = 1.5;
/** Cap recovery probe at this multiple of current estimate. */
export const kProbeRecoveryMaxScale = 2.0;
/**
 * libwebrtc ProbeControllerConfig `loss_limited_probe_scale` default (1.5).
 * When BandwidthLimitedCause is kLossLimitedBweIncreasing, InitiateProbing
 * caps max_probe_bitrate at estimated × this scale.
 */
export const kLossLimitedProbeScale = 1.5;
/**
 * libwebrtc RttBasedBackoff `configured_limit_` default (WebRTC-Bwe-MaxRttLimit
 * field trial, default 3s). CorrectedRtt > this → IsRttAboveLimit →
 * kRttBasedBackOffHighRtt → no new probes + periodic target drop.
 */
export const kRttBasedBackOffHighRttMs = 3_000;
/** libwebrtc RttBasedBackoff drop_fraction_ default (0.8). */
export const kRttBasedBackOffDropFraction = 0.8;
/** libwebrtc RttBasedBackoff drop_interval_ default (1s). */
export const kRttBasedBackOffDropIntervalMs = 1_000;
/**
 * libwebrtc RttBasedBackoff bandwidth_floor_ default (5 kbps).
 * Clamped up to {@link kMinBitrateBps} when applied in werift.
 */
export const kRttBasedBackOffBandwidthFloorBps = 5_000;
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
  "Probe pacing uses RTCRtpSender token-bucket + RTP padding injection (not webrtc::PacedSender); 3x/6x queued FIFO — pacing advances on send-fill (minBytes AND minPackets), not on ACK; ProbeController result-wait (sender clock 1s) is separate from ProbeBitrateEstimator history (receive timeline 1s + sender-side kSentInfoMaxAgeMs cap; zero-packet timeouts never enter history) so late TWCC after controller complete can still yield estimates within the window; further after 80% still refines pending estimate; when uncapped further/recovery/initial target ≥ max_bitrate (or cause max_probe), clamp and stop further (probe_further=false, min_bitrate_to_probe_further=+inf); active clusters are never aborted mid-send by TWCC loss/overuse — new recovery/further probes use GetBandwidthLimitedCause mapping: underuse/overuse → forbid; RTT > 3s (kRttBasedBackOffHighRtt) → forbid; loss decreasing/hold → forbid; loss increasing → allow with max_probe = estimated × 1.5 (loss_limited_probe_scale); delay_based → allow uncapped (configured max only); recovery only on underuse→normal (recovered_from_overuse); upward probe results apply unless overuse (lower results still applied with acked×0.85 floor); 5s cooldown; no ALR-only / network-state-estimate probe path",
  "AIMD: TimeToReduceFurther (RTT spacing + throughput check) and hold-after-decrease ported; RTT proxy = feedback arrival − last send (not full ICE/STUN CorrectedRtt which adds time-since-last-send when feedback stalls); any finite proxy updates lastFeedbackRttMs (clamped ≥0), including <10ms recovery and >30s spikes, so high-RTT probe forbid / RttBasedBackoff clear when RTT returns to normal; AIMD decrease spacing only uses a clamped [10, 2000] ms RTT; IsRttAboveLimit uses the unclamped proxy vs 3s and applies RttBasedBackoff drop (×0.8 / 1s, floor max(minBitrate, 5kbps)); probe accept uses setEstimate (preserves RTT / max-bitrate stats), not full reset",
  "Acknowledged bitrate uses RobustThroughputEstimator defaults (window_packets=20, min_duration=1s, required_packets=10, largest-gap replace); Bayesian BitrateEstimator kept as utility; prior_unacked_data / ALR hooks omitted (all TWCC-tagged media)",
  "TWCC 24-bit reference_time is unwrapped across feedbacks in GccBandwidthEstimator (continuous ms timeline); packetResults alone still report raw wrap-relative times; ReceiverTWCC late-reorder history is ~500ms (time-based) with a sequence safety bound",
  "Floating-point / wall-clock differences may cause sub-bps numerical drift vs C++ (not bit-identical to libwebrtc public test vectors)",
  "InterArrivalDelta: reordered-reset / arrival-offset thresholds ported; system-clock path omitted (TWCC receive times only)",
  "Transport-wide sequence is shared on the DTLS transport while BWE instances are per RTCRtpSender (ticket constraint; multi-sender asymmetry is intentional)",
  "OveruseDetector class is unused at runtime (TrendlineEstimator::Detect owns hypothesis); BandwidthUsage type is shared",
] as const;

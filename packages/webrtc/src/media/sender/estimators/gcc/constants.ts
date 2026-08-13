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

/**
 * pin `kCongestionControllerMinBitrate` (bwe_defines.h) = 5 kbps.
 * Auditable via third_party/libwebrtc-ref snapshot.
 */
export const kMinBitrateBps = 5_000;
export const kMaxBitrateBps = 1_000_000_000;

/** Burst grouping window for inter-arrival pre-filter (ms). */
export const kBurstTimeMs = 5;

/**
 * Delay-based stream idle timeout (ms).
 * libwebrtc `DelayBasedBwe::kStreamTimeOut` = 2s — reset InterArrivalDelta +
 * TrendlineEstimator when no packet feedback arrives for this long.
 */
export const kStreamTimeOutMs = 2_000;

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

// --- AIMD (pin aimd_rate_control.cc) ---

/** Multiplicative decrease factor (pin kDefaultBackoffFactor / beta_ = 0.85). */
export const kBeta = 0.85;
/** Multiplicative increase base per second (pin alpha = 1.08). */
export const kMultiplicativeIncreaseFactor = 1.08;
/**
 * Extra delay added to RTT for near-max additive response time
 * (pin: response_time = (rtt + 100ms) * 2).
 */
export const kReactionTimeMs = 100;
export const kBitrateWindowMs = 1000;
/**
 * pin `kDefaultRtt` = 200ms. AIMD RTT is **not** TWCC propagation RTT;
 * only OnRoundTripTimeUpdate / RTCP RR path updates it via setRtt.
 */
export const kDefaultRttMs = 200;
/**
 * TimeToReduceFurther throughput check: estimated_throughput < 0.5 * estimate.
 */
export const kThroughputLowerFraction = 0.5;
/**
 * Subtracted from beta * throughput on overuse when result > 5 kbps
 * (pin: decreased_bitrate -= 5 kbps).
 */
export const kAimdDecreaseOffsetBps = 5_000;
/**
 * Additive increase floor (pin kMinIncreaseRateBpsPerSecond = 4000).
 */
export const kAimdMinIncreaseRateBpsPerSecond = 4_000;
/**
 * Multiplicative increase floor per update (pin BitsPerSec(1000)).
 */
export const kAimdMinMultiplicativeIncreaseBps = 1_000;
/**
 * Throughput upper bound offset on increase (pin + 10 kbps).
 */
export const kAimdThroughputUpperOffsetBps = 10_000;

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
/**
 * pin `kDefaultMaxProbingBitrate` (5 Mbps). Used when the application did
 * not configure a lower max (ensureProbing default).
 */
export const kDefaultMaxProbingBitrateBps = 5_000_000;
/** pin `kBitrateDropThreshold` — record a large drop at this fraction. */
export const kBitrateDropThreshold = 0.66;
/** pin `kBitrateDropTimeout` (5s). */
export const kBitrateDropTimeoutMs = 5_000;
/** pin `kProbeFractionAfterDrop` (0.85 × bitrate_before_last_large_drop). */
export const kProbeFractionAfterDrop = 0.85;
/** pin `kAlrEndedTimeout` (3s). */
export const kAlrEndedTimeoutMs = 3_000;
/** pin `kMinTimeBetweenAlrProbes` (5s). */
export const kMinTimeBetweenAlrProbesMs = 5_000;
/** pin `kProbeUncertainty` (0.05). Skip recovery if estimate is already close. */
export const kProbeUncertainty = 0.05;
/** @deprecated further-step only; recovery uses {@link kProbeFractionAfterDrop}. */
export const kProbeRecoveryScale = 1.5;
/** Cap further/uncapped step (not pin RequestProbe). */
export const kProbeRecoveryMaxScale = 2.0;
/**
 * libwebrtc ProbeControllerConfig `loss_limited_probe_scale` default (1.5).
 * When BandwidthLimitedCause is kLossLimitedBweIncreasing, InitiateProbing
 * caps max_probe_bitrate at estimated × this scale.
 */
export const kLossLimitedProbeScale = 1.5;

/** pin AlrDetectorConfig `bandwidth_usage_ratio` (0.65). */
export const kAlrBandwidthUsageRatio = 0.65;
/** pin AlrDetectorConfig `start_budget_level_ratio` (0.80). */
export const kAlrStartBudgetLevelRatio = 0.8;
/** pin AlrDetectorConfig `stop_budget_level_ratio` (0.50). */
export const kAlrStopBudgetLevelRatio = 0.5;
/** pin ProbeControllerConfig `alr_interval` (5s). */
export const kAlrProbingIntervalMs = 5_000;
/** pin ProbeControllerConfig `alr_scale` (2). */
export const kAlrProbeScale = 2;
/**
 * pin ProbeControllerConfig `network_state_interval` default (+∞).
 * Periodic NSE probes stay idle until an interval is configured.
 */
export const kNetworkStateEstimateProbingIntervalMs = Number.POSITIVE_INFINITY;
/** pin `est_lower_than_network_ratio` default (0). */
export const kEstimateLowerThanNetworkStateRatio = 0;
/** pin `est_lower_than_network_interval` default (3s). */
export const kEstimateLowerThanNetworkStateIntervalMs = 3_000;
/** pin `network_state_scale` default (1.0). */
export const kNetworkStateProbeScale = 1;
/**
 * pin LossBasedBweV2 `PaddingDuration` default (0).
 * Non-zero enables `increase_using_padding` instead of `increasing`.
 */
export const kLossBasedPaddingDurationMs = 0;
/**
 * RTT threshold for RttBasedBackoff::IsRttAboveLimit (pin
 * send_side_bandwidth_estimation + goog_cc_network_control):
 * when CorrectedRtt (timeout_correction + **propagation** RTT) exceeds this,
 * GetBandwidthLimitedCause becomes kRttBasedBackOffHighRtt and
 * ProbeController::InitiateProbing returns no clusters.
 * Default 3s = WebRTC-Bwe-MaxRttLimit field-trial default (`limit`).
 * Raw max_feedback_rtt is **not** used for probe cause (CWND only in pin).
 * SendSideBandwidthEstimation::UpdateEstimate also multiplies the target by
 * {@link kRttBasedBackOffDropFraction} every {@link kRttBasedBackOffDropIntervalMs}
 * down to {@link kRttBasedBackOffBandwidthFloorBps}.
 */
export const kRttBasedBackOffHighRttMs = 3_000;
/** pin RttBasedBackoff `drop_fraction` default (0.8). */
export const kRttBasedBackOffDropFraction = 0.8;
/** pin RttBasedBackoff `drop_interval` default (1s). */
export const kRttBasedBackOffDropIntervalMs = 1_000;
/** pin RttBasedBackoff `bandwidth_floor` default (5 kbps). */
export const kRttBasedBackOffBandwidthFloorBps = 5_000;
/**
 * pin kProbeDropThroughputFraction: when a valid probe result is **below** the
 * current delay estimate, floor at acked×this so a single glitchy probe cannot
 * crash the estimate far below observed throughput. **No matching upward cap**
 * in pin production path — rising probes pass through to Aimd SetEstimate.
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

/**
 * pin `TransportFeedbackAdapter` `kSendTimeHistoryWindow` = 60s.
 * Sent packet history (and never-ACK probe estimator maps) live this long
 * so late TWCC can still match. Not a 2048-sequence cap.
 */
export const kSendTimeHistoryWindowMs = 60_000;
/** @deprecated Use {@link kSendTimeHistoryWindowMs}. */
export const kSentInfoMaxAgeMs = kSendTimeHistoryWindowMs;

/**
 * pin `GoogCcNetworkControllerFactory::GetProcessInterval`
 * `kUpdateIntervalMs` = 25.
 */
export const kGoogCcProcessIntervalMs = 25;

/**
 * Intentional differences vs Chromium libwebrtc goog_cc.
 * Acceptable under the ticket's pure-TypeScript / no C++ binding constraint;
 * algorithm structure and control response match the reference.
 */
export const GCC_KNOWN_DIFFERENCES = [
  "LossBasedBweV2: byte-loss objective/derivative (UseByteLossRate), bias adjustment by loss ratio, instant upper/lower bounds, delayed-increase window, HOLD (state stays decreasing while holdUntil active; ramp-up 1.2× when acked still below hold×1.3 else 1.5×); IncreaseUsingPadding is implemented (pin PaddingDuration default 0 → increasing; non-zero duration enters increase_using_padding and maps to kLossLimitedBwe)",
  "No REMB integration; TWCC-only send-side mode (ticket non-goal; future work)",
  "Probe pacing uses RTCRtpSender token-bucket + RTP padding injection (not webrtc::PacedSender); 3x/6x queued FIFO — pacing advances on send-fill (minBytes AND minPackets), not on ACK; ProbeController result-wait (sender clock 1s) is separate from ProbeBitrateEstimator history (receive timeline 1s + sender-side kSendTimeHistoryWindowMs=60s cap matching pin TransportFeedbackAdapter; zero-packet timeouts never enter history) so late TWCC after controller complete can still yield estimates within the window; further after 80% still refines pending estimate; SetEstimatedBitrate further only while waiting_for_result (pin); session complete (timeout/empty queue/abort) sets min_bitrate_to_probe_further=+∞ so further cannot re-open after complete; when uncapped further/recovery/initial target ≥ max_bitrate (or cause max_probe), clamp and stop further (probe_further=false, min=+inf); active clusters are never aborted mid-send by TWCC loss/overuse — update order matches pin DelayBasedBwe::MaybeUpdateEstimate: while overusing ignore probe_bitrate entirely (AIMD TimeToReduceFurther only); when not overusing apply probe SetEstimate on delay path **without upward caps** (lower results floored with acked×0.85 only); recovered_from_overuse only when no probe_bitrate this feedback and not overusing; then LossBasedBwe.update(post-probe delay) → GetBandwidthLimitedCause from **post-loss** state; underuse/overuse → forbid; CorrectedRtt (propagation + timeout) > 3s → forbid; loss decreasing/hold/increase_using_padding → forbid; loss increasing → allow with max_probe = estimated × 1.5; delay_based → allow uncapped; recovery via pin RequestProbe (ALR or ALR-ended <3s + large drop <5s → 0.85×bitrate_before_last_large_drop, probe_further=false, 5s min between drop probes) latched on per-packet underuse→normal; AlrDetector + periodic ALR probing (alr_interval=5s, alr_scale=2) is **opt-in** (`periodicAlrProbing` constructor / EnablePeriodicAlrProbing; pin default false — not auto-enabled after first TWCC); network-state estimate path (SetNetworkStateEstimate + Process TimeForNetworkStateProbe; default interval +∞ so idle until configured); default max probe 5 Mbps (pin kDefaultMaxProbingBitrate) when the app does not set a lower cap",
  "AIMD ported from pin aimd_rate_control: ChangeState/ChangeBitrate, decrease = throughput×β then −5kbps if >5kbps, increase limit 1.5×throughput+10kbps, multiplicative 1.08^Δt (min +1000bps), additive via GetNearMaxIncreaseRate ((rtt+100ms)×2, min 4000bps/s), LinkCapacityEstimator (pin Reset clears estimate only; full resetAll on estimator reset); TimeToReduceFurther clamps RTT to [10,200]ms; default RTT 200ms; AIMD RTT only via RoundTripTimeConsumer.setRoundTripTime with **raw** RTCP RR RTT (pin discards smoothed updates; stats EWMA is separate) — RttBasedBackoff propagation RTT is separate (IsRttAboveLimit + ×0.8 drop then GetUpperLimit=delay/max and min_bitrate 5kbps via BandwidthEstimatorProcessor.process at pin 25ms ProcessInterval / TWCC; rtpPacketSent is pin OnSentPacket only — ALR OnBytesSent, history, first-packet UpdatePropagationRtt(send,0), OnSentPacket, probe send-fill — no UpdateEstimate / ProbeController::Process); process() order is UpdateEstimate → SetAlrStartTime → ProbeController::Process → MaybeTriggerOnNetworkChanged; high-RTT UpdateEstimate never adopts LossBased result; NetworkStateEstimate bound on ClampBitrate omitted; DelayBasedBwe kStreamTimeOut (2s) resets InterArrivalDelta + TrendlineEstimator; sentInfos / probe seq maps key by unwrapped transport-wide seq (pin TransportFeedbackAdapter + SeqNumUnwrapper) and age out on process() as well as send (60s window, no 2048-seq cap)",
  "Acknowledged bitrate uses RobustThroughputEstimator defaults (window_packets=20, min_duration=1s, required_packets=10, largest-gap replace); Bayesian BitrateEstimator kept as utility; SetAlr/SetAlrEndedTime are no-ops on the Robust path (pin RobustThroughputEstimator)",
  "TWCC 24-bit reference_time is unwrapped across feedbacks in GccBandwidthEstimator (continuous ms timeline); packetResults alone still report raw wrap-relative times; ReceiverTWCC late-reorder history is ~500ms (time-based) with a sequence safety bound",
  "Floating-point / wall-clock differences may cause sub-bps numerical drift vs C++ (not bit-identical to libwebrtc public test vectors)",
  "InterArrivalDelta: reordered-reset / arrival-offset thresholds ported; system-clock path omitted (TWCC receive times only)",
  "Transport-wide sequence is shared on the DTLS transport while BWE instances are per RTCRtpSender (ticket constraint; multi-sender asymmetry is intentional)",
  "OveruseDetector class is unused at runtime (TrendlineEstimator::Detect owns hypothesis); BandwidthUsage type is shared",
] as const;

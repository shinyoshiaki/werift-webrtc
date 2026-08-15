[**werift**](../README.md)

***

[werift](../globals.md) / GccBandwidthEstimator

# Class: GccBandwidthEstimator

Google Congestion Control send-side bandwidth estimator (libwebrtc-aligned).

- [TrendlineEstimator](TrendlineEstimator.md): delay gradient + overuse hypothesis
- [AimdRateControl](AimdRateControl.md): delay-based A_hat
- [LossBasedBwe](LossBasedBwe.md): loss path
- [ProbeController](ProbeController.md): exponential / further probes

Bitrate is published only after at least one **known** sent sequence is
observed in TWCC (empty / unmatched feedback does not notify).

## Implements

- [`BandwidthEstimator`](../interfaces/BandwidthEstimator.md)
- [`ProbePacingController`](../interfaces/ProbePacingController.md)
- [`RoundTripTimeConsumer`](../interfaces/RoundTripTimeConsumer.md)
- [`BandwidthEstimatorProcessor`](../interfaces/BandwidthEstimatorProcessor.md)
- [`NetworkAvailabilityConsumer`](../interfaces/NetworkAvailabilityConsumer.md)

## Constructors

### new GccBandwidthEstimator()

> **new GccBandwidthEstimator**(`startBitrateBps`, `options`?): [`GccBandwidthEstimator`](GccBandwidthEstimator.md)

#### Parameters

##### startBitrateBps

`number` = `kDefaultStartBitrateBps`

Initial target / AIMD start (bps).

##### options?

[`GccBandwidthEstimatorOptions`](../type-aliases/GccBandwidthEstimatorOptions.md)

#### Returns

[`GccBandwidthEstimator`](GccBandwidthEstimator.md)

## Properties

### onAvailableBitrate

> `readonly` **onAvailableBitrate**: [`Event`](Event.md)\<\[`number`\]\>

Fires when the recommended send bitrate (**bps**) **changes**.
Unit is always bits per second (bps). Change-only (not every recompute).

#### Implementation of

[`BandwidthEstimator`](../interfaces/BandwidthEstimator.md).[`onAvailableBitrate`](../interfaces/BandwidthEstimator.md#onavailablebitrate)

***

### onOveruseDetected

> `readonly` **onOveruseDetected**: [`Event`](Event.md)\<\[[`BandwidthUsage`](../type-aliases/BandwidthUsage.md)\]\>

***

### onProbeClusterConfig

> `readonly` **onProbeClusterConfig**: [`Event`](Event.md)\<\[[`ProbeClusterConfig`](../interfaces/ProbeClusterConfig.md)\]\>

***

### knownDifferences

> `readonly` `static` **knownDifferences**: readonly \[`"LossBasedBweV2: byte-loss objective/derivative (UseByteLossRate), bias adjustment by loss ratio, instant upper/lower bounds, delayed-increase window, current_best_estimate_ vs loss_based_result_ (HOLD publishes min(holdRate, bounded) without rewriting the candidate model), HOLD is kDecreasing + last_hold_info_ timer (no kHold state; arm only when entering decreasing), acked-rate ramp-up cap applied after best-candidate selection (not in GetCandidates) plus 1bps decreasing→increasing nudge, state vs configured max_bitrate_ (not the 1 Gbps default); GetCandidates does not pre-clamp to configured max (Newton/objective see the window upper; final bound uses InstantUpperBound/max); bandwidth_limit_in_current_window_ starts +∞ (IsValid = Number.isFinite); IncreaseUsingPadding + CanKeepIncreasingState (pin PaddingDuration default 2s — stay in increase_using_padding while last_padding+2s >= last_send or padding_rate < estimate); GetCandidates(in_alr) skips acked-rate in ALR (NotUseAckedRateInAlr) unless padding window still open; CalculateAverageReportedByteLossRatio excludes min/max loss-rate observations when n>3 unless max-loss send rate ≥ median×2; PushBackObservation increments num_packets/size on every feedback appearance (lost map is seq-keyed); late lost→received unmarks only the current partial observation (committed observations are not rewritten); Newton/state run only after a committed observation; current_best starts uninitialized and copies delay_based_estimate_ on the first commit; GetLossBasedResult stays kDelayBasedEstimate until IsReady and returns +Infinity (not current-best) when delay is unset; SendSide UpdateEstimate / receiveTWCC / process adopt LossBased only when IsReady"`, `"No REMB integration; TWCC-only send-side mode (ticket non-goal; future work)"`, `` "Probe pacing uses RTCRtpSender token-bucket + RTP padding injection (not webrtc::PacedSender); 3x/6x queued FIFO — pacing advances on send-fill (minBytes AND minPackets), not on ACK; ProbeController result-wait (sender clock 1s) is separate from ProbeBitrateEstimator history (receive timeline 1s + sender-side kSendTimeHistoryWindowMs=60s cap matching pin TransportFeedbackAdapter; zero-packet timeouts never enter history) so late TWCC after controller complete can still yield estimates within the window; further after 80% still refines pending estimate; SetEstimatedBitrate further only while waiting_for_result (pin); session complete (timeout/empty queue/abort) sets min_bitrate_to_probe_further=+∞ so further cannot re-open after complete; when uncapped further/recovery/initial target ≥ max_bitrate (or cause max_probe), clamp and stop further (probe_further=false, min=+inf); SetBitrates in kProbingComplete starts a single probe at the new max when max increases and estimate < new max (pin); probe_further=false → kProbingComplete (pacing FIFO continues); unset target max is 1 Gbps and probe max is 5 Mbps (setBitrates applies the same app max to both); ClampConstraints at setBitrates: min floor 5 kbps, max raised to min, start raised to min when start>0 — same triple to AIMD / LossBased / ProbeController / ApplyTargetLimits; delay_based_limit_ is +∞ until a delay-path result (all-lost TWCC does not install the start bitrate as a delay cap); SetSendBitrate(start>0) clears that limit; ProbeController.reset keeps periodic ALR / network-available / alr_start and sets last_bwe_drop_probing_time_ / time_of_last_large_drop_ to at_time (RequestProbe time_since_probe>5s and time_since_drop<5s); active clusters are never aborted mid-send by TWCC loss/overuse — update order matches pin DelayBasedBwe::MaybeUpdateEstimate: while overusing ignore probe_bitrate entirely (AIMD TimeToReduceFurther only); when not overusing apply probe SetEstimate on delay path **without upward caps** (lower results floored with acked×0.85 only); recovered_from_overuse only when no probe_bitrate this feedback and not overusing; then LossBasedBwe.update(post-probe delay) → GetBandwidthLimitedCause from **post-loss** state; underuse/overuse → forbid; CorrectedRtt (propagation + timeout) > 3s → forbid; loss decreasing/increase_using_padding → forbid; loss increasing → allow with max_probe = estimated × 1.5; delay_based → allow uncapped; recovery via pin RequestProbe (ALR or ALR-ended <3s + large drop <5s → 0.85×bitrate_before_last_large_drop, probe_further=false, 5s min between drop probes) latched on per-packet underuse→normal; AlrDetector + periodic ALR probing (alr_interval=5s, alr_scale=2) is **opt-in** (`periodicAlrProbing` constructor / EnablePeriodicAlrProbing; pin default false — not auto-enabled after first TWCC); network-state estimate path (SetNetworkStateEstimate + Process TimeForNetworkStateProbe; default interval +∞ so idle until configured); default max probe 5 Mbps (pin kDefaultMaxProbingBitrate) when the app does not set a lower cap" ``, `"AIMD ported from pin aimd_rate_control: ChangeState/ChangeBitrate, decrease = throughput×β then −5kbps if >5kbps, increase limit 1.5×throughput+10kbps, multiplicative 1.08^Δt (min +1000bps), additive via GetNearMaxIncreaseRate ((rtt+100ms)×2, min 4000bps/s), LinkCapacityEstimator (pin Reset clears estimate only; full resetAll on estimator reset); TimeToReduceFurther clamps RTT to [10,200]ms; default RTT 200ms; AIMD RTT only via RoundTripTimeConsumer.setRoundTripTime with **raw** RTCP RR RTT (pin discards smoothed updates; stats EWMA is separate) — RttBasedBackoff propagation RTT is separate (IsRttAboveLimit + ×0.8 drop then GetUpperLimit=delay/max and min_bitrate 5kbps via BandwidthEstimatorProcessor.process at pin 25ms ProcessInterval / TWCC; rtpPacketSent is pin OnSentPacket only — ALR OnBytesSent, history, first-packet UpdatePropagationRtt(send,0), OnSentPacket, probe send-fill — no UpdateEstimate / ProbeController::Process); receiveTWCC is pin OnTransportPacketsFeedback — ALR-ended first, delay only when SortedByReceiveTime is non-empty, no ProbeController::Process; ensureProbing / SetBitrates only on first ProcessInterval (not rtpPacketSent / shouldTag / padding queries); ProbeController network_available_ starts false — OnNetworkAvailability(true) from DTLS connected (or already-connected setBandwidthEstimator) starts 3x/6x; receiveTWCC MaybeTrigger only when DelayBasedBwe Result.updated (all-lost / no-timing / overuse without TimeToReduceFurther wait for ProcessInterval; probes below last delay estimate and NSE link_capacity_lower are ignored); process() first tick ensureProbing then UpdateEstimate → SetAlrStartTime → ProbeController::Process → MaybeTriggerOnNetworkChanged; high-RTT UpdateEstimate never adopts LossBased result; NetworkStateEstimate upper/lower applied in AIMD ClampBitrate when set; DelayBasedBwe kStreamTimeOut (2s) resets InterArrivalDelta + TrendlineEstimator; sentInfos / probe seq maps key by unwrapped transport-wide seq (pin TransportFeedbackAdapter + SeqNumUnwrapper) and age out on process() as well as send (60s window, no 2048-seq cap)"`, `"Acknowledged bitrate uses RobustThroughputEstimator defaults (window_packets=20, min_duration=1s, required_packets=10, largest-gap replace); Bayesian BitrateEstimator kept as utility; SetAlr/SetAlrEndedTime are no-ops on the Robust path (pin RobustThroughputEstimator)"`, `"TWCC 24-bit reference_time is unwrapped across feedbacks in GccBandwidthEstimator (continuous ms timeline); packetResults alone still report raw wrap-relative times; ReceiverTWCC late-reorder history is ~500ms (time-based) with a sequence safety bound"`, `"Floating-point / wall-clock differences may cause sub-bps numerical drift vs C++ (not bit-identical to libwebrtc public test vectors)"`, `"InterArrivalDelta: reordered-reset / arrival−system offset (>=3000ms) ported; production passes feedback_time as system_time"`, `"Transport-wide sequence is shared on the DTLS transport while BWE instances are per RTCRtpSender (ticket constraint; multi-sender asymmetry is intentional)"`, `"OveruseDetector class is unused at runtime (TrendlineEstimator::Detect owns hypothesis); BandwidthUsage type is shared"`\] = `GCC_KNOWN_DIFFERENCES`

## Accessors

### availableBitrate

#### Get Signature

> **get** **availableBitrate**(): `number`

Recommended / estimated available send bitrate in **bps**.
May remain `0` until TWCC is negotiated and enough samples are collected.

##### Returns

`number`

Recommended / estimated available send bitrate in **bps**.
May remain `0` until TWCC is negotiated and enough samples are collected.

#### Implementation of

[`BandwidthEstimator`](../interfaces/BandwidthEstimator.md).[`availableBitrate`](../interfaces/BandwidthEstimator.md#availablebitrate)

***

### correctedRttMs

#### Get Signature

> **get** **correctedRttMs**(): `number`

pin CorrectedRtt = timeout_correction + last propagation RTT.
Grows while packets are sent without TWCC (feedback stall).

##### Returns

`number`

***

### probeState

#### Get Signature

> **get** **probeState**(): [`ProbeState`](../type-aliases/ProbeState.md)

##### Returns

[`ProbeState`](../type-aliases/ProbeState.md)

***

### rttAboveLimit

#### Get Signature

> **get** **rttAboveLimit**(): `boolean`

pin `RttBasedBackoff::IsRttAboveLimit` (CorrectedRtt > 3s).

##### Returns

`boolean`

***

### suggestedProbeBitrateBps

#### Get Signature

> **get** **suggestedProbeBitrateBps**(): `number`

##### Returns

`number`

***

### usageState

#### Get Signature

> **get** **usageState**(): [`BandwidthUsage`](../type-aliases/BandwidthUsage.md)

##### Returns

[`BandwidthUsage`](../type-aliases/BandwidthUsage.md)

## Methods

### dispose()

> **dispose**(): `void`

Release listeners / timers when the sender replaces the estimator.
[RTCRtpSender](RTCRtpSender.md) rebinds its stable `onAvailableBitrate` bridge after dispose.

#### Returns

`void`

#### Implementation of

[`BandwidthEstimator`](../interfaces/BandwidthEstimator.md).[`dispose`](../interfaces/BandwidthEstimator.md#dispose)

***

### enablePeriodicAlrProbing()

> **enablePeriodicAlrProbing**(`enable`): `void`

pin `EnablePeriodicAlrProbing` / later `OnStreamsConfig`.
Default remains false until the caller opts in.

#### Parameters

##### enable

`boolean`

#### Returns

`void`

***

### getPacingBitrateBps()

> **getPacingBitrateBps**(): `number`

Pacing target (bps) for the send engine.
Typically `max(availableBitrate, activeProbeTarget)`.

#### Returns

`number`

#### Implementation of

[`ProbePacingController`](../interfaces/ProbePacingController.md).[`getPacingBitrateBps`](../interfaces/ProbePacingController.md#getpacingbitratebps)

***

### getPaddingBitrateBps()

> **getPaddingBitrateBps**(): `number`

pin `GetPacingRates` padding_rate when loss state is
`kIncreaseUsingPadding`: last loss-based target (current target).

#### Returns

`number`

#### Implementation of

[`ProbePacingController`](../interfaces/ProbePacingController.md).[`getPaddingBitrateBps`](../interfaces/ProbePacingController.md#getpaddingbitratebps)

***

### pendingLossPaddingPackets()

> **pendingLossPaddingPackets**(`packetBytes`): `number`

Padding packets to send so the token-bucket approaches
[getPaddingBitrateBps](GccBandwidthEstimator.md#getpaddingbitratebps) when media is sparse. 0 while probing.

#### Parameters

##### packetBytes

`number` = `kProbePaddingPacketBytes`

#### Returns

`number`

#### Implementation of

[`ProbePacingController`](../interfaces/ProbePacingController.md).[`pendingLossPaddingPackets`](../interfaces/ProbePacingController.md#pendinglosspaddingpackets)

***

### pendingProbePaddingPackets()

> **pendingProbePaddingPackets**(`packetBytes`): `number`

How many padding packets the sender should inject to progress the active
probe cluster when media is sparse. 0 if not probing or cluster is full.

#### Parameters

##### packetBytes

`number` = `kProbePaddingPacketBytes`

#### Returns

`number`

#### Implementation of

[`ProbePacingController`](../interfaces/ProbePacingController.md).[`pendingProbePaddingPackets`](../interfaces/ProbePacingController.md#pendingprobepaddingpackets)

***

### process()

> **process**(`nowMs`): `void`

pin GoogCcNetworkController::OnProcessInterval order:
  ResetConstraints / SetBitrates (first interval → ensureProbing)
  → UpdateEstimate
  → SetAlrStartTime
  → ProbeController::Process
  → MaybeTriggerOnNetworkChanged

Process still sees the **previous** BandwidthLimitedCause. A tick that
first crosses the RTT limit can therefore emit a due ALR probe, and only
afterwards publish `kRttBasedBackOffHighRtt`. Does **not** call
[RttBasedBackoff.onSentPacket](RttBasedBackoff.md#onsentpacket).

#### Parameters

##### nowMs

`number`

#### Returns

`void`

#### Implementation of

[`BandwidthEstimatorProcessor`](../interfaces/BandwidthEstimatorProcessor.md).[`process`](../interfaces/BandwidthEstimatorProcessor.md#process)

***

### receiveTWCC()

> **receiveTWCC**(`feedback`): `void`

Process a Transport-Wide CC RTCP feedback packet and update the estimate.

#### Parameters

##### feedback

[`TransportWideCC`](TransportWideCC.md)

#### Returns

`void`

#### Implementation of

[`BandwidthEstimator`](../interfaces/BandwidthEstimator.md).[`receiveTWCC`](../interfaces/BandwidthEstimator.md#receivetwcc)

***

### reset()

> **reset**(): `void`

Clear internal history / estimates.

#### Returns

`void`

#### Implementation of

[`BandwidthEstimator`](../interfaces/BandwidthEstimator.md).[`reset`](../interfaces/BandwidthEstimator.md#reset)

***

### rtpPacketSent()

> **rtpPacketSent**(`info`): `void`

Record an outgoing RTP packet for later matching against TWCC feedback.

#### Parameters

##### info

[`SentInfo`](../interfaces/SentInfo.md)

#### Returns

`void`

#### Implementation of

[`BandwidthEstimator`](../interfaces/BandwidthEstimator.md).[`rtpPacketSent`](../interfaces/BandwidthEstimator.md#rtppacketsent)

***

### setBitrates()

> **setBitrates**(`minBps`, `startBps`, `maxBps`): `void`

pin `OnTargetRateConstraints` / `ResetConstraints` / `ClampConstraints`
then `ProbeController::SetBitrates`.

Constraints are normalized **once** at this entrance (pin order):
min floored at [kMinBitrateBps](../variables/kMinBitrateBps.md) → max raised to min → start
raised to min when `start > 0`. The same triple is then applied to
AIMD, LossBasedBwe, ProbeController, and applyTargetLimits.

While probing is `complete`, a **higher** max than the previous max
(and than the current estimate) starts a single probe at the new max
(`probe_further=false`, pin `SetBitrates` / `kProbingComplete`).

#### Parameters

##### minBps

`number`

##### startBps

`number`

##### maxBps

`number`

#### Returns

`void`

***

### setNetworkAvailable()

> **setNetworkAvailable**(`available`): `void`

pin `OnNetworkAvailability`. Initial 3x/6x probing starts only after the
transport is send-ready (and SetBitrates / first ProcessInterval has
stored a start bitrate).

#### Parameters

##### available

`boolean`

#### Returns

`void`

#### Implementation of

[`NetworkAvailabilityConsumer`](../interfaces/NetworkAvailabilityConsumer.md).[`setNetworkAvailable`](../interfaces/NetworkAvailabilityConsumer.md#setnetworkavailable)

***

### setNetworkStateEstimate()

> **setNetworkStateEstimate**(`linkCapacityUpperBps`, `linkCapacityLowerBps`): `void`

pin `OnNetworkStateEstimate` / `SetNetworkStateEstimate`.
`linkCapacityUpperBps <= 0` clears the estimate on ProbeController and AIMD.

#### Parameters

##### linkCapacityUpperBps

`number`

##### linkCapacityLowerBps

`number` = `0`

#### Returns

`void`

***

### setRoundTripTime()

> **setRoundTripTime**(`rttMs`): `void`

pin OnRoundTripTimeUpdate → DelayBasedBwe::OnRttUpdate → AimdRateControl::SetRtt.
Callers must pass **raw** (unsmoothed) RTCP RR RTT in milliseconds — pin
GoogCc discards smoothed RTT updates. Independent of TWCC propagation RTT
used by [RttBasedBackoff](RttBasedBackoff.md).

#### Parameters

##### rttMs

`number`

#### Returns

`void`

#### Implementation of

[`RoundTripTimeConsumer`](../interfaces/RoundTripTimeConsumer.md).[`setRoundTripTime`](../interfaces/RoundTripTimeConsumer.md#setroundtriptime)

***

### shouldTagProbePacket()

> **shouldTagProbePacket**(): `boolean`

Tag the next outgoing packet as a probe (`SentInfo.isProbation`).

#### Returns

`boolean`

#### Implementation of

[`ProbePacingController`](../interfaces/ProbePacingController.md).[`shouldTagProbePacket`](../interfaces/ProbePacingController.md#shouldtagprobepacket)

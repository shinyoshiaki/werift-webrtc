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

## Constructors

### new GccBandwidthEstimator()

> **new GccBandwidthEstimator**(`startBitrateBps`): [`GccBandwidthEstimator`](GccBandwidthEstimator.md)

#### Parameters

##### startBitrateBps

`number` = `kDefaultStartBitrateBps`

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

> `readonly` `static` **knownDifferences**: readonly \[`"LossBasedBweV2: byte-loss objective/derivative (UseByteLossRate), bias adjustment by loss ratio, instant upper/lower bounds, delayed-increase window, HOLD (state stays decreasing while holdUntil active; ramp-up 1.2× when acked still below hold×1.3 else 1.5×); full ALR/padding-duration state machine simplified (IncreaseUsingPadding collapsed into increasing when padding path is unused)"`, `"No REMB integration; TWCC-only send-side mode (ticket non-goal; future work)"`, `"Probe pacing uses RTCRtpSender token-bucket + RTP padding injection (not webrtc::PacedSender); 3x/6x queued FIFO — pacing advances on send-fill (minBytes AND minPackets), not on ACK; ProbeController result-wait (sender clock 1s) is separate from ProbeBitrateEstimator history (receive timeline 1s + sender-side kSentInfoMaxAgeMs cap; zero-packet timeouts never enter history) so late TWCC after controller complete can still yield estimates within the window; further after 80% still refines pending estimate; SetEstimatedBitrate further only while waiting_for_result (pin); session complete (timeout/empty queue/abort) sets min_bitrate_to_probe_further=+∞ so further cannot re-open after complete; when uncapped further/recovery/initial target ≥ max_bitrate (or cause max_probe), clamp and stop further (probe_further=false, min=+inf); active clusters are never aborted mid-send by TWCC loss/overuse — update order matches pin DelayBasedBwe::MaybeUpdateEstimate: while overusing ignore probe_bitrate entirely (AIMD TimeToReduceFurther only); when not overusing apply probe SetEstimate on delay path **without upward caps** (lower results floored with acked×0.85 only); recovered_from_overuse only when no probe_bitrate this feedback and not overusing; then LossBasedBwe.update(post-probe delay) → GetBandwidthLimitedCause from **post-loss** state; underuse/overuse → forbid; CorrectedRtt (propagation + timeout) > 3s → forbid; loss decreasing/hold → forbid; loss increasing → allow with max_probe = estimated × 1.5; delay_based → allow uncapped; recovery latched on per-packet underuse→normal; 5s cooldown; no ALR-only / network-state-estimate probe path"`, `"AIMD ported from pin aimd_rate_control: ChangeState/ChangeBitrate, decrease = throughput×β then −5kbps if >5kbps, increase limit 1.5×throughput+10kbps, multiplicative 1.08^Δt (min +1000bps), additive via GetNearMaxIncreaseRate ((rtt+100ms)×2, min 4000bps/s), LinkCapacityEstimator (pin Reset clears estimate only; full resetAll on estimator reset); TimeToReduceFurther clamps RTT to [10,200]ms; default RTT 200ms; AIMD RTT only via RoundTripTimeConsumer.setRoundTripTime with **raw** RTCP RR RTT (pin discards smoothed updates; stats EWMA is separate) — RttBasedBackoff propagation RTT is separate (IsRttAboveLimit + ×0.8 target drop every 1s to 5kbps floor via sender-clock process on rtpPacketSent; first packet UpdatePropagationRtt(send,0) like pin OnSentPacket); NetworkStateEstimate bound on ClampBitrate omitted; DelayBasedBwe kStreamTimeOut (2s) resets InterArrivalDelta + TrendlineEstimator"`, `"Acknowledged bitrate uses RobustThroughputEstimator defaults (window_packets=20, min_duration=1s, required_packets=10, largest-gap replace); Bayesian BitrateEstimator kept as utility; prior_unacked_data / ALR hooks omitted (all TWCC-tagged media)"`, `"TWCC 24-bit reference_time is unwrapped across feedbacks in GccBandwidthEstimator (continuous ms timeline); packetResults alone still report raw wrap-relative times; ReceiverTWCC late-reorder history is ~500ms (time-based) with a sequence safety bound"`, `"Floating-point / wall-clock differences may cause sub-bps numerical drift vs C++ (not bit-identical to libwebrtc public test vectors)"`, `"InterArrivalDelta: reordered-reset / arrival-offset thresholds ported; system-clock path omitted (TWCC receive times only)"`, `"Transport-wide sequence is shared on the DTLS transport while BWE instances are per RTCRtpSender (ticket constraint; multi-sender asymmetry is intentional)"`, `"OveruseDetector class is unused at runtime (TrendlineEstimator::Detect owns hypothesis); BandwidthUsage type is shared"`\] = `GCC_KNOWN_DIFFERENCES`

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

### probeState

#### Get Signature

> **get** **probeState**(): [`ProbeState`](../type-aliases/ProbeState.md)

##### Returns

[`ProbeState`](../type-aliases/ProbeState.md)

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

### getPacingBitrateBps()

> **getPacingBitrateBps**(): `number`

Pacing target (bps) for the send engine.
Typically `max(availableBitrate, activeProbeTarget)`.

#### Returns

`number`

#### Implementation of

[`ProbePacingController`](../interfaces/ProbePacingController.md).[`getPacingBitrateBps`](../interfaces/ProbePacingController.md#getpacingbitratebps)

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

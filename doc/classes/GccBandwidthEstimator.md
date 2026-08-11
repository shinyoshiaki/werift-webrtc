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

> `readonly` `static` **knownDifferences**: readonly \[`"LossBasedBweV2: byte-loss objective/derivative (UseByteLossRate), bias adjustment by loss ratio, instant upper/lower bounds, delayed-increase window, HOLD (state stays decreasing while holdUntil active; ramp-up 1.2× when acked still below hold×1.3 else 1.5×); full ALR/padding-duration state machine simplified (IncreaseUsingPadding collapsed into increasing when padding path is unused)"`, `"No REMB integration; TWCC-only send-side mode (ticket non-goal; future work)"`, `"Probe pacing uses RTCRtpSender token-bucket + RTP padding injection (not webrtc::PacedSender); 3x/6x queued FIFO — pacing advances on send-fill (minBytes AND minPackets), not on ACK; result clusters await TWCC until result timeout (not cleared at first 80% estimate); ProbeBitrateEstimator uses ACKed-only min/max send·recv times and sizes (order-independent); further after 80% still refines pending estimate; when uncapped further/recovery target would exceed max_bitrate (strict >), one last max probe then min_bitrate_to_probe_further=+inf; upward probe blocked when congested, lower probe still applied with acked×0.85 floor; recovery + 5s cooldown; abort on loss≥5% or overuse; no ALR-only probe path"`, `"AIMD: TimeToReduceFurther (RTT spacing + throughput check) and hold-after-decrease ported; RTT is estimated from feedback arrival − last send (not full ICE/STUN RTT stats / NetworkController RTT)"`, `"TWCC 24-bit reference_time is unwrapped across feedbacks in GccBandwidthEstimator (continuous ms timeline); packetResults alone still report raw wrap-relative times; ReceiverTWCC late-reorder history is ~500ms (time-based) with a sequence safety bound"`, `"Floating-point / wall-clock differences may cause sub-bps numerical drift vs C++ (not bit-identical to libwebrtc public test vectors)"`, `"InterArrivalDelta: reordered-reset / arrival-offset thresholds ported; system-clock path omitted (TWCC receive times only)"`, `"Transport-wide sequence is shared on the DTLS transport while BWE instances are per RTCRtpSender (ticket constraint; multi-sender asymmetry is intentional)"`\] = `GCC_KNOWN_DIFFERENCES`

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

### shouldTagProbePacket()

> **shouldTagProbePacket**(): `boolean`

Tag the next outgoing packet as a probe (`SentInfo.isProbation`).

#### Returns

`boolean`

#### Implementation of

[`ProbePacingController`](../interfaces/ProbePacingController.md).[`shouldTagProbePacket`](../interfaces/ProbePacingController.md#shouldtagprobepacket)

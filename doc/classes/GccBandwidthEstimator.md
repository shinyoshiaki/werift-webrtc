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

> `readonly` `static` **knownDifferences**: readonly \[`"LossBasedBweV2: observation window, candidates, Newton inherent-loss update, and objective ranking ported; TCP-fairness upper bound omitted (optional Chromium path)"`, `"No REMB integration; TWCC-only send-side mode (ticket non-goal)"`, `"Probe pacing uses RTCRtpSender token-bucket + RTP padding injection (not webrtc::PacedSender)"`, `"Floating-point / wall-clock differences may cause sub-bps numerical drift vs C++"`\] = `GCC_KNOWN_DIFFERENCES`

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

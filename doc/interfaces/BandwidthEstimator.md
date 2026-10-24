[**werift**](../README.md)

***

[werift](../globals.md) / BandwidthEstimator

# Interface: BandwidthEstimator

Common contract for send-side bandwidth estimators driven by TWCC feedback.

TWCC I/O and recommended bitrate (`rtpPacketSent` / `receiveTWCC` /
`availableBitrate` / `onAvailableBitrate`) are required. GCC also needs
probe / pacing / RTT / process-interval hooks; those live on this same
interface so [RTCRtpSender](../classes/RTCRtpSender.md) does not import GCC. Legacy and disabled
estimators implement them as no-ops (`processIntervalMs === 0`, padding
sizes 0, methods return false / 0 / undefined).

## Properties

### availableBitrate

> `readonly` **availableBitrate**: `number`

Recommended / estimated available send bitrate in **bps**.
May remain `0` until TWCC is negotiated and enough samples are collected.

***

### onAvailableBitrate

> `readonly` **onAvailableBitrate**: [`Event`](../classes/Event.md)\<\[`number`\]\>

Fires when the recommended send bitrate (**bps**) **changes**.
Unit is always bits per second (bps). Change-only (not every recompute).

***

### onProbeClusterConfig

> `readonly` **onProbeClusterConfig**: [`Event`](../classes/Event.md)\<\[[`ProbeClusterConfig`](ProbeClusterConfig.md)\]\>

Fires when a probe cluster is activated. Legacy / disabled never fire.

***

### probePaddingMaxBurst

> `readonly` **probePaddingMaxBurst**: `number`

Max padding packets per inner send burst. `0` when padding is disabled.

***

### probePaddingPacketBytes

> `readonly` **probePaddingPacketBytes**: `number`

RTP padding size used when the sender injects probe / loss padding.
`0` — do not inject padding (legacy / disabled).

***

### processIntervalMs

> `readonly` **processIntervalMs**: `number`

Sender-clock process interval in milliseconds (pin GoogCc 25ms).
`0` — do not run a process timer (legacy / disabled).

## Methods

### dispose()?

> `optional` **dispose**(): `void`

Release listeners / timers when the sender replaces the estimator.
[RTCRtpSender](../classes/RTCRtpSender.md) rebinds its stable `onAvailableBitrate` bridge after dispose.

#### Returns

`void`

***

### getPacingBitrateBps()

> **getPacingBitrateBps**(): `number`

Pacing target (bps) for the send engine.
pin GetPacingRates: estimate × 2.5 before first TWCC, × 1.1 after,
raised to the active probe target while probing.
`0` — do not token-bucket pace (legacy / disabled).

#### Returns

`number`

***

### getPaddingBitrateBps()

> **getPaddingBitrateBps**(): `number`

pin `GetPacingRates` padding_rate while loss-limited
`kIncreaseUsingPadding`. 0 when not in that state.

#### Returns

`number`

***

### pendingLossPaddingPackets()

> **pendingLossPaddingPackets**(`packetBytes`?): `number`

Padding packets to send to approach [getPaddingBitrateBps](BandwidthEstimator.md#getpaddingbitratebps) when
media is sparse. Not probe/probation packets.

#### Parameters

##### packetBytes?

`number`

#### Returns

`number`

***

### pendingProbePaddingPackets()

> **pendingProbePaddingPackets**(`packetBytes`?): `number`

Number of padding packets the sender should inject to fill the active
probe cluster when media alone is insufficient.

#### Parameters

##### packetBytes?

`number`

#### Returns

`number`

***

### process()

> **process**(`nowMs`): `void`

Advance sender-clock estimator state at `nowMs` (milliseconds).
Does not count as a sent packet — CorrectedRtt timeout only grows on
`rtpPacketSent`.

#### Parameters

##### nowMs

`number`

#### Returns

`void`

***

### receiveTWCC()

> **receiveTWCC**(`feedback`): `void`

Process a Transport-Wide CC RTCP feedback packet and update the estimate.

#### Parameters

##### feedback

[`TransportWideCC`](../classes/TransportWideCC.md)

#### Returns

`void`

***

### reserveOutgoingProbe()

> **reserveOutgoingProbe**(`nowMs`): `undefined` \| [`ProbeReservation`](ProbeReservation.md)

pin `BitrateProber::CurrentCluster` — reserve the active probe cluster
**before** the packet is sent (not at send-complete callback).

#### Parameters

##### nowMs

`number`

#### Returns

`undefined` \| [`ProbeReservation`](ProbeReservation.md)

***

### reset()?

> `optional` **reset**(): `void`

Clear internal history / estimates.

#### Returns

`void`

***

### rtpPacketSent()

> **rtpPacketSent**(`info`): `void`

Record an outgoing RTP packet for later matching against TWCC feedback.

#### Parameters

##### info

[`SentInfo`](SentInfo.md)

#### Returns

`void`

***

### setNetworkAvailable()

> **setNetworkAvailable**(`available`): `void`

True when ICE/DTLS (or equivalent) can emit RTP.

#### Parameters

##### available

`boolean`

#### Returns

`void`

***

### setRoundTripTime()

> **setRoundTripTime**(`rttMs`): `void`

Raw round-trip time in **milliseconds** (not TWCC propagation RTT).
Pin GoogCc ignores smoothed RTT and only applies unsmoothed updates.

#### Parameters

##### rttMs

`number`

#### Returns

`void`

***

### shouldTagProbePacket()

> **shouldTagProbePacket**(): `boolean`

Tag the next outgoing packet as a probe (`SentInfo.isProbation`).

#### Returns

`boolean`

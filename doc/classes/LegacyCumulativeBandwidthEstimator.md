[**werift**](../README.md)

***

[werift](../globals.md) / LegacyCumulativeBandwidthEstimator

# Class: LegacyCumulativeBandwidthEstimator

Legacy cumulative min(send, recv) bandwidth estimator (mediasoup-inspired).

This is the **default** send-side BWE used by [RTCRtpSender](RTCRtpSender.md).
Implements [BandwidthEstimator](../interfaces/BandwidthEstimator.md); congestion-related events are **legacy-only**
and are not part of the shared interface. GCC send-path hooks (probe, pacing,
RTT, process interval) are no-ops so [RTCRtpSender](RTCRtpSender.md) can call them
unconditionally.

## See

CumulativeResult

## Extends

- [`BandwidthEstimatorNoopHooks`](BandwidthEstimatorNoopHooks.md)

## Implements

- [`BandwidthEstimator`](../interfaces/BandwidthEstimator.md)

## Constructors

### Constructor

> **new LegacyCumulativeBandwidthEstimator**(): `SenderBandwidthEstimator`

#### Returns

`SenderBandwidthEstimator`

#### Inherited from

[`BandwidthEstimatorNoopHooks`](BandwidthEstimatorNoopHooks.md).[`constructor`](BandwidthEstimatorNoopHooks.md#constructor)

## Properties

### \_compatCongestionScore

> `protected` **\_compatCongestionScore**: `number` = `1`

#### Inherited from

[`BandwidthEstimatorNoopHooks`](BandwidthEstimatorNoopHooks.md).[`_compatCongestionScore`](BandwidthEstimatorNoopHooks.md#_compatcongestionscore)

***

### ~~congestion~~

> **congestion**: `boolean` = `false`

#### Deprecated

Always false except on SenderBandwidthEstimator.

#### Overrides

[`BandwidthEstimatorNoopHooks`](BandwidthEstimatorNoopHooks.md).[`congestion`](BandwidthEstimatorNoopHooks.md#congestion)

***

### onAvailableBitrate

> `readonly` **onAvailableBitrate**: [`Event`](Event.md)\<\[`number`\]\>

Fires when recommended send bitrate (**bps**) changes.

#### See

BandwidthEstimator.onAvailableBitrate

#### Implementation of

[`BandwidthEstimator`](../interfaces/BandwidthEstimator.md).[`onAvailableBitrate`](../interfaces/BandwidthEstimator.md#onavailablebitrate)

***

### onCongestion

> `readonly` **onCongestion**: [`Event`](Event.md)\<\[`boolean`\]\>

Legacy-only: whether congestion is considered active.

#### Overrides

[`BandwidthEstimatorNoopHooks`](BandwidthEstimatorNoopHooks.md).[`onCongestion`](BandwidthEstimatorNoopHooks.md#oncongestion)

***

### onCongestionScore

> `readonly` **onCongestionScore**: [`Event`](Event.md)\<\[`number`\]\>

Legacy-only: congestion score 1–10 (higher is worse).

#### Overrides

[`BandwidthEstimatorNoopHooks`](BandwidthEstimatorNoopHooks.md).[`onCongestionScore`](BandwidthEstimatorNoopHooks.md#oncongestionscore)

***

### onProbeClusterConfig

> `readonly` **onProbeClusterConfig**: [`Event`](Event.md)\<\[[`ProbeClusterConfig`](../interfaces/ProbeClusterConfig.md)\]\>

Fires when a probe cluster is activated. Legacy / disabled never fire.

#### Implementation of

[`BandwidthEstimator`](../interfaces/BandwidthEstimator.md).[`onProbeClusterConfig`](../interfaces/BandwidthEstimator.md#onprobeclusterconfig)

#### Inherited from

[`BandwidthEstimatorNoopHooks`](BandwidthEstimatorNoopHooks.md).[`onProbeClusterConfig`](BandwidthEstimatorNoopHooks.md#onprobeclusterconfig)

***

### probePaddingMaxBurst

> `readonly` **probePaddingMaxBurst**: `0` = `0`

Max padding packets per inner send burst. `0` when padding is disabled.

#### Implementation of

[`BandwidthEstimator`](../interfaces/BandwidthEstimator.md).[`probePaddingMaxBurst`](../interfaces/BandwidthEstimator.md#probepaddingmaxburst)

#### Inherited from

[`BandwidthEstimatorNoopHooks`](BandwidthEstimatorNoopHooks.md).[`probePaddingMaxBurst`](BandwidthEstimatorNoopHooks.md#probepaddingmaxburst)

***

### probePaddingPacketBytes

> `readonly` **probePaddingPacketBytes**: `0` = `0`

RTP padding size used when the sender injects probe / loss padding.
`0` — do not inject padding (legacy / disabled).

#### Implementation of

[`BandwidthEstimator`](../interfaces/BandwidthEstimator.md).[`probePaddingPacketBytes`](../interfaces/BandwidthEstimator.md#probepaddingpacketbytes)

#### Inherited from

[`BandwidthEstimatorNoopHooks`](BandwidthEstimatorNoopHooks.md).[`probePaddingPacketBytes`](BandwidthEstimatorNoopHooks.md#probepaddingpacketbytes)

***

### processIntervalMs

> `readonly` **processIntervalMs**: `0` = `0`

Sender-clock process interval in milliseconds (pin GoogCc 25ms).
`0` — do not run a process timer (legacy / disabled).

#### Implementation of

[`BandwidthEstimator`](../interfaces/BandwidthEstimator.md).[`processIntervalMs`](../interfaces/BandwidthEstimator.md#processintervalms)

#### Inherited from

[`BandwidthEstimatorNoopHooks`](BandwidthEstimatorNoopHooks.md).[`processIntervalMs`](BandwidthEstimatorNoopHooks.md#processintervalms)

## Accessors

### availableBitrate

#### Get Signature

> **get** **availableBitrate**(): `number`

Recommended / estimated available send bitrate in **bps**.
May remain `0` until TWCC is negotiated and enough samples are collected.

##### Returns

`number`

#### Set Signature

> **set** **availableBitrate**(`v`): `void`

Recommended / estimated available send bitrate in **bps**.
May remain `0` until TWCC is negotiated and enough samples are collected.

##### Parameters

###### v

`number`

##### Returns

`void`

Recommended / estimated available send bitrate in **bps**.
May remain `0` until TWCC is negotiated and enough samples are collected.

#### Implementation of

[`BandwidthEstimator`](../interfaces/BandwidthEstimator.md).[`availableBitrate`](../interfaces/BandwidthEstimator.md#availablebitrate)

***

### congestionScore

#### Get Signature

> **get** **congestionScore**(): `number`

1–10; larger means worse congestion (legacy-specific).

##### Returns

`number`

#### Set Signature

> **set** **congestionScore**(`v`): `void`

##### Deprecated

Always 1 except on SenderBandwidthEstimator.

##### Parameters

###### v

`number`

##### Returns

`void`

#### Overrides

[`BandwidthEstimatorNoopHooks`](BandwidthEstimatorNoopHooks.md).[`congestionScore`](BandwidthEstimatorNoopHooks.md#congestionscore)

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

### disposeNoopHooks()

> `protected` **disposeNoopHooks**(): `void`

#### Returns

`void`

#### Inherited from

[`BandwidthEstimatorNoopHooks`](BandwidthEstimatorNoopHooks.md).[`disposeNoopHooks`](BandwidthEstimatorNoopHooks.md#disposenoophooks)

***

### getPacingBitrateBps()

> **getPacingBitrateBps**(): `number`

Pacing target (bps) for the send engine.
pin GetPacingRates: estimate × 2.5 before first TWCC, × 1.1 after,
raised to the active probe target while probing.
`0` — do not token-bucket pace (legacy / disabled).

#### Returns

`number`

#### Implementation of

[`BandwidthEstimator`](../interfaces/BandwidthEstimator.md).[`getPacingBitrateBps`](../interfaces/BandwidthEstimator.md#getpacingbitratebps)

#### Inherited from

[`BandwidthEstimatorNoopHooks`](BandwidthEstimatorNoopHooks.md).[`getPacingBitrateBps`](BandwidthEstimatorNoopHooks.md#getpacingbitratebps)

***

### getPaddingBitrateBps()

> **getPaddingBitrateBps**(): `number`

pin `GetPacingRates` padding_rate while loss-limited
`kIncreaseUsingPadding`. 0 when not in that state.

#### Returns

`number`

#### Implementation of

[`BandwidthEstimator`](../interfaces/BandwidthEstimator.md).[`getPaddingBitrateBps`](../interfaces/BandwidthEstimator.md#getpaddingbitratebps)

#### Inherited from

[`BandwidthEstimatorNoopHooks`](BandwidthEstimatorNoopHooks.md).[`getPaddingBitrateBps`](BandwidthEstimatorNoopHooks.md#getpaddingbitratebps)

***

### pendingLossPaddingPackets()

> **pendingLossPaddingPackets**(`_packetBytes?`): `number`

Padding packets to send to approach [getPaddingBitrateBps](../interfaces/BandwidthEstimator.md#getpaddingbitratebps) when
media is sparse. Not probe/probation packets.

#### Parameters

##### \_packetBytes?

`number`

#### Returns

`number`

#### Implementation of

[`BandwidthEstimator`](../interfaces/BandwidthEstimator.md).[`pendingLossPaddingPackets`](../interfaces/BandwidthEstimator.md#pendinglosspaddingpackets)

#### Inherited from

[`BandwidthEstimatorNoopHooks`](BandwidthEstimatorNoopHooks.md).[`pendingLossPaddingPackets`](BandwidthEstimatorNoopHooks.md#pendinglosspaddingpackets)

***

### pendingProbePaddingPackets()

> **pendingProbePaddingPackets**(`_packetBytes?`): `number`

Number of padding packets the sender should inject to fill the active
probe cluster when media alone is insufficient.

#### Parameters

##### \_packetBytes?

`number`

#### Returns

`number`

#### Implementation of

[`BandwidthEstimator`](../interfaces/BandwidthEstimator.md).[`pendingProbePaddingPackets`](../interfaces/BandwidthEstimator.md#pendingprobepaddingpackets)

#### Inherited from

[`BandwidthEstimatorNoopHooks`](BandwidthEstimatorNoopHooks.md).[`pendingProbePaddingPackets`](BandwidthEstimatorNoopHooks.md#pendingprobepaddingpackets)

***

### process()

> **process**(`_nowMs`): `void`

Advance sender-clock estimator state at `nowMs` (milliseconds).
Does not count as a sent packet — CorrectedRtt timeout only grows on
`rtpPacketSent`.

#### Parameters

##### \_nowMs

`number`

#### Returns

`void`

#### Implementation of

[`BandwidthEstimator`](../interfaces/BandwidthEstimator.md).[`process`](../interfaces/BandwidthEstimator.md#process)

#### Inherited from

[`BandwidthEstimatorNoopHooks`](BandwidthEstimatorNoopHooks.md).[`process`](BandwidthEstimatorNoopHooks.md#process)

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

### reserveOutgoingProbe()

> **reserveOutgoingProbe**(`_nowMs`): [`ProbeReservation`](../interfaces/ProbeReservation.md) \| `undefined`

pin `BitrateProber::CurrentCluster` — reserve the active probe cluster
**before** the packet is sent (not at send-complete callback).

#### Parameters

##### \_nowMs

`number`

#### Returns

[`ProbeReservation`](../interfaces/ProbeReservation.md) \| `undefined`

#### Implementation of

[`BandwidthEstimator`](../interfaces/BandwidthEstimator.md).[`reserveOutgoingProbe`](../interfaces/BandwidthEstimator.md#reserveoutgoingprobe)

#### Inherited from

[`BandwidthEstimatorNoopHooks`](BandwidthEstimatorNoopHooks.md).[`reserveOutgoingProbe`](BandwidthEstimatorNoopHooks.md#reserveoutgoingprobe)

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

> **rtpPacketSent**(`sentInfo`): `void`

Record an outgoing RTP packet for later matching against TWCC feedback.

#### Parameters

##### sentInfo

[`SentInfo`](../interfaces/SentInfo.md)

#### Returns

`void`

#### Implementation of

[`BandwidthEstimator`](../interfaces/BandwidthEstimator.md).[`rtpPacketSent`](../interfaces/BandwidthEstimator.md#rtppacketsent)

***

### setNetworkAvailable()

> **setNetworkAvailable**(`_available`): `void`

True when ICE/DTLS (or equivalent) can emit RTP.

#### Parameters

##### \_available

`boolean`

#### Returns

`void`

#### Implementation of

[`BandwidthEstimator`](../interfaces/BandwidthEstimator.md).[`setNetworkAvailable`](../interfaces/BandwidthEstimator.md#setnetworkavailable)

#### Inherited from

[`BandwidthEstimatorNoopHooks`](BandwidthEstimatorNoopHooks.md).[`setNetworkAvailable`](BandwidthEstimatorNoopHooks.md#setnetworkavailable)

***

### setRoundTripTime()

> **setRoundTripTime**(`_rttMs`): `void`

Raw round-trip time in **milliseconds** (not TWCC propagation RTT).
Pin GoogCc ignores smoothed RTT and only applies unsmoothed updates.

#### Parameters

##### \_rttMs

`number`

#### Returns

`void`

#### Implementation of

[`BandwidthEstimator`](../interfaces/BandwidthEstimator.md).[`setRoundTripTime`](../interfaces/BandwidthEstimator.md#setroundtriptime)

#### Inherited from

[`BandwidthEstimatorNoopHooks`](BandwidthEstimatorNoopHooks.md).[`setRoundTripTime`](BandwidthEstimatorNoopHooks.md#setroundtriptime)

***

### shouldTagProbePacket()

> **shouldTagProbePacket**(): `boolean`

Tag the next outgoing packet as a probe (`SentInfo.isProbation`).

#### Returns

`boolean`

#### Implementation of

[`BandwidthEstimator`](../interfaces/BandwidthEstimator.md).[`shouldTagProbePacket`](../interfaces/BandwidthEstimator.md#shouldtagprobepacket)

#### Inherited from

[`BandwidthEstimatorNoopHooks`](BandwidthEstimatorNoopHooks.md).[`shouldTagProbePacket`](BandwidthEstimatorNoopHooks.md#shouldtagprobepacket)

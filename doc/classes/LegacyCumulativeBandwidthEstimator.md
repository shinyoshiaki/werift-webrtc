[**werift**](../README.md)

***

[werift](../globals.md) / LegacyCumulativeBandwidthEstimator

# Class: LegacyCumulativeBandwidthEstimator

Legacy cumulative min(send, recv) bandwidth estimator (mediasoup-inspired).

This is the **default** send-side BWE used by [RTCRtpSender](RTCRtpSender.md).
Implements [BandwidthEstimator](../interfaces/BandwidthEstimator.md); congestion-related events are **legacy-only**
and are not part of the shared interface.

## See

CumulativeResult

## Implements

- [`BandwidthEstimator`](../interfaces/BandwidthEstimator.md)

## Constructors

### new LegacyCumulativeBandwidthEstimator()

> **new LegacyCumulativeBandwidthEstimator**(): [`LegacyCumulativeBandwidthEstimator`](LegacyCumulativeBandwidthEstimator.md)

#### Returns

[`LegacyCumulativeBandwidthEstimator`](LegacyCumulativeBandwidthEstimator.md)

## Properties

### congestion

> **congestion**: `boolean` = `false`

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

***

### onCongestionScore

> `readonly` **onCongestionScore**: [`Event`](Event.md)\<\[`number`\]\>

Legacy-only: congestion score 1–10 (higher is worse).

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

##### Parameters

###### v

`number`

##### Returns

`void`

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

> **rtpPacketSent**(`sentInfo`): `void`

Record an outgoing RTP packet for later matching against TWCC feedback.

#### Parameters

##### sentInfo

[`SentInfo`](../interfaces/SentInfo.md)

#### Returns

`void`

#### Implementation of

[`BandwidthEstimator`](../interfaces/BandwidthEstimator.md).[`rtpPacketSent`](../interfaces/BandwidthEstimator.md#rtppacketsent)

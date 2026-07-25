[**werift**](../README.md)

***

[werift](../globals.md) / BandwidthEstimator

# Interface: BandwidthEstimator

Common contract for send-side bandwidth estimators driven by TWCC feedback.

Limited to TWCC I/O + recommended bitrate. Probe / pacing hooks live on
[ProbePacingController](ProbePacingController.md) so the shared surface stays thin.

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

## Methods

### dispose()?

> `optional` **dispose**(): `void`

Release listeners / timers when the sender replaces the estimator.
[RTCRtpSender](../classes/RTCRtpSender.md) rebinds its stable `onAvailableBitrate` bridge after dispose.

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

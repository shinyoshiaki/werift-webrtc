[**werift**](../README.md)

***

[werift](../globals.md) / BandwidthEstimatorProcessor

# Interface: BandwidthEstimatorProcessor

Optional periodic process surface (pin GoogCc `OnProcessInterval`).

Not part of the common [BandwidthEstimator](BandwidthEstimator.md) contract. Callers (e.g.
[RTCRtpSender](../classes/RTCRtpSender.md) RTCP loop) advance sender-clock work such as RTT-based
target backoff while media may be idle.

## Methods

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

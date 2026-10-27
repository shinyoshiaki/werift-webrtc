[**werift**](../README.md)

***

[werift](../globals.md) / RTCRtpSenderOptions

# Type Alias: RTCRtpSenderOptions

> **RTCRtpSenderOptions** = `object`

## Properties

### bandwidthEstimator?

> `optional` **bandwidthEstimator**: [`BandwidthEstimator`](../interfaces/BandwidthEstimator.md)

Initial send-side bandwidth estimator. When omitted, the default is
[SenderBandwidthEstimator](../classes/LegacyCumulativeBandwidthEstimator.md). [RTCPeerConnection](../classes/RTCPeerConnection.md) passes the
instance created from [PeerConfig.bandwidthEstimator](../interfaces/PeerConfig.md#bandwidthestimator).

### pendingRtp?

> `optional` **pendingRtp?**: `boolean` \| [`PendingRtpOptions`](PendingRtpOptions.md)

Pending RTP cache. Disabled by default. Pass `true` or `{ maxLength }` to enable.

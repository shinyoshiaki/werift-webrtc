[**werift**](../README.md)

***

[werift](../globals.md) / RTCRtpSenderOptions

# Type Alias: RTCRtpSenderOptions

> **RTCRtpSenderOptions** = `object`

## Properties

### pendingRtp?

> `optional` **pendingRtp?**: `boolean` \| [`PendingRtpOptions`](PendingRtpOptions.md)

Pending RTP cache. Disabled by default. Pass `true` or `{ maxLength }` to enable.

***

### rtpHistorySize?

> `optional` **rtpHistorySize?**: `number`

Recent packet history available for RTCP or application requested retransmission.

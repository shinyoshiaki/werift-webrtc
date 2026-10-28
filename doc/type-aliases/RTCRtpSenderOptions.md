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

Packets kept for retransmission (NACK / `retransmit()`). Default 128
(about 2.5s of 20ms Opus). Raise it for a longer latency budget.

[**werift**](../README.md)

***

[werift](../globals.md) / RtpTimelineRewriterOptions

# Interface: RtpTimelineRewriterOptions

## Properties

### clockRate?

> `optional` **clockRate?**: `number`

RTP clock rate of the stream in Hz (90000 for video). Needed by `"wallClock"`.

***

### defaultTimestampStep?

> `optional` **defaultTimestampStep?**: `number`

Increment used by `"lastDelta"` before any increment was seen. Default 1.

***

### inPlace?

> `optional` **inPlace?**: `boolean`

Rewrite the header of the given packet instead of a clone. Default false:
received packets (`MediaStreamTrack.onReceiveRtp`) are shared by every
subscriber and must not be changed.

***

### now?

> `optional` **now?**: () => `number`

Monotonic clock in milliseconds. Default `performance.now()`. For tests.

#### Returns

`number`

***

### payloadType?

> `optional` **payloadType?**: `number`

Fixed output payload type. Default: keep the input payload type.

***

### ssrc?

> `optional` **ssrc?**: `number`

Fixed output SSRC (for example the downstream SRTP SSRC). Default: keep the input SSRC.

***

### switchOnSsrcChange?

> `optional` **switchOnSsrcChange?**: `boolean`

Treat a change of the input SSRC as a source switch, like a new `source`
key. Late packets of the previous SSRC are then dropped. Default true.
Set false only when the input SSRC changes without a timeline change.

***

### timestampStep?

> `optional` **timestampStep?**: [`RtpTimestampStepMode`](../type-aliases/RtpTimestampStepMode.md)

Timestamp increment at a source switch. Default `"auto"`.

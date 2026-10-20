[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / RtpBuilderCreateOptions

# Interface: RtpBuilderCreateOptions

## Properties

### elapsedSamples?

> `optional` **elapsedSamples**: `number`

Samples to advance for this packet. `0` keeps the current timestamp.

***

### marker?

> `optional` **marker**: `boolean`

***

### tick?

> `optional` **tick**: `Pick`\<[`RtpMediaClockTick`](RtpMediaClockTick.md), `"timestamp"`\>

Use the timestamp of a media clock tick (or `RtpMediaPacer` tick).

***

### timestamp?

> `optional` **timestamp**: `number`

Absolute RTP timestamp (application-owned timeline, e.g. relay).

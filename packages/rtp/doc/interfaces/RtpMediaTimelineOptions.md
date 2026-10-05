[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / RtpMediaTimelineOptions

# Interface: RtpMediaTimelineOptions

## Extended by

- [`RtpMediaClockOptions`](RtpMediaClockOptions.md)

## Properties

### clockRate

> **clockRate**: `number`

RTP clock rate in Hz (e.g. 48000 for Opus, 90000 for video).

***

### frameDurationMs?

> `optional` **frameDurationMs**: `number`

Frame duration in milliseconds. May be fractional.

***

### frameSamples?

> `optional` **frameSamples**: `number`

Samples per frame. May be fractional (e.g. 90000 / 29.97).
Exactly one of `frameSamples` / `frameDurationMs` must be given.

***

### initialTimestamp?

> `optional` **initialTimestamp**: `number`

RTP timestamp of frame 0. Default: random32().

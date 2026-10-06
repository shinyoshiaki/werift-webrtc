[**werift**](../README.md)

***

[werift](../globals.md) / RtpMediaClockOptions

# Interface: RtpMediaClockOptions

## Extends

- [`RtpMediaTimelineOptions`](RtpMediaTimelineOptions.md)

## Properties

### clockRate

> **clockRate**: `number`

RTP clock rate in Hz (e.g. 48000 for Opus, 90000 for video).

#### Inherited from

[`RtpMediaTimelineOptions`](RtpMediaTimelineOptions.md).[`clockRate`](RtpMediaTimelineOptions.md#clockrate)

***

### frameDurationMs?

> `optional` **frameDurationMs**: `number`

Frame duration in milliseconds. May be fractional.

#### Inherited from

[`RtpMediaTimelineOptions`](RtpMediaTimelineOptions.md).[`frameDurationMs`](RtpMediaTimelineOptions.md#framedurationms)

***

### frameSamples?

> `optional` **frameSamples**: `number`

Samples per frame. May be fractional (e.g. 90000 / 29.97).
Exactly one of `frameSamples` / `frameDurationMs` must be given.

#### Inherited from

[`RtpMediaTimelineOptions`](RtpMediaTimelineOptions.md).[`frameSamples`](RtpMediaTimelineOptions.md#framesamples)

***

### initialTimestamp?

> `optional` **initialTimestamp**: `number`

RTP timestamp of frame 0. Default: random32().

#### Inherited from

[`RtpMediaTimelineOptions`](RtpMediaTimelineOptions.md).[`initialTimestamp`](RtpMediaTimelineOptions.md#initialtimestamp)

***

### now()?

> `optional` **now**: () => `number`

Monotonic time source in ms. Default: `performance.now()`.

#### Returns

`number`

***

### scheduler?

> `optional` **scheduler**: [`RtpMediaClockScheduler`](RtpMediaClockScheduler.md)

Timer implementation. Default: global setTimeout / clearTimeout.

***

### signal?

> `optional` **signal**: `AbortSignal`

Aborting the signal is equivalent to `stop()`.

***

### unref?

> `optional` **unref**: `boolean`

Call `unref()` on timer handles (Node.js only). Default: false.

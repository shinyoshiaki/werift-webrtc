[**werift**](../README.md)

***

[werift](../globals.md) / RtpMediaPacerOptions

# Interface: RtpMediaPacerOptions

## Properties

### clockRate

> **clockRate**: `number`

RTP clock rate in Hz (e.g. 90000 for video).

***

### initialTimestamp?

> `optional` **initialTimestamp**: `number`

RTP timestamp of the first pushed frame's `pts`. Default: random32().

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

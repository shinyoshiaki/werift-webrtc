[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / RtpMediaClock

# Class: RtpMediaClock

Monotonic real-time RTP media clock / pacer.

- Each slot N is scheduled at the absolute deadline
  `origin + N * frameDurationMs`, so timer lateness never accumulates.
- When the event loop stalls past several deadlines, `onTick` fires once.
  With `stallPolicy: "skip"` (default) it fires for the latest reached slot;
  the slots in between are reported via `skippedFrames` and appear as a
  timestamp gap. With `"delay"` it fires for the next slot and re-anchors
  the timeline, so no slot is skipped. Late ticks are never burst.
- `onTick` subscribers are invoked synchronously after the internal state
  (including the next timer) has been updated. Returned promises are not
  awaited; backpressure is out of scope.
- `resume()` re-anchors the origin to the resume time and emits a tick
  immediately. With `"skip"` the paused time is reflected as a timestamp gap
  by default; pass `{ continuous: true }` to collapse it (default for
  `"delay"`).

This is an opt-in utility for media sources. `RTCRtpSender.sendRtp()` never
rewrites RTP timestamps based on send time.

## Constructors

### new RtpMediaClock()

> **new RtpMediaClock**(`options`): [`RtpMediaClock`](RtpMediaClock.md)

#### Parameters

##### options

[`RtpMediaClockOptions`](../interfaces/RtpMediaClockOptions.md)

#### Returns

[`RtpMediaClock`](RtpMediaClock.md)

## Properties

### onTick

> `readonly` **onTick**: [`Event`](Event.md)\<\[[`RtpMediaClockTick`](../interfaces/RtpMediaClockTick.md)\]\>

***

### stallPolicy

> `readonly` **stallPolicy**: [`RtpMediaClockStallPolicy`](../type-aliases/RtpMediaClockStallPolicy.md)

***

### timeline

> `readonly` **timeline**: [`RtpMediaTimeline`](RtpMediaTimeline.md)

## Accessors

### clockRate

#### Get Signature

> **get** **clockRate**(): `number`

##### Returns

`number`

***

### lastTick

#### Get Signature

> **get** **lastTick**(): `undefined` \| [`RtpMediaClockTick`](../interfaces/RtpMediaClockTick.md)

The most recently emitted tick.

##### Returns

`undefined` \| [`RtpMediaClockTick`](../interfaces/RtpMediaClockTick.md)

***

### state

#### Get Signature

> **get** **state**(): [`RtpMediaClockState`](../type-aliases/RtpMediaClockState.md)

##### Returns

[`RtpMediaClockState`](../type-aliases/RtpMediaClockState.md)

***

### timestamp

#### Get Signature

> **get** **timestamp**(): `number`

RTP timestamp of the latest tick, or of frame 0 before the first tick.

##### Returns

`number`

## Methods

### pause()

> **pause**(): `void`

#### Returns

`void`

***

### resume()

> **resume**(`options`): `void`

#### Parameters

##### options

[`RtpMediaClockResumeOptions`](../interfaces/RtpMediaClockResumeOptions.md) = `{}`

#### Returns

`void`

***

### start()

> **start**(`onTick`?): `void`

#### Parameters

##### onTick?

(`tick`) => `void`

#### Returns

`void`

***

### stop()

> **stop**(): `void`

#### Returns

`void`

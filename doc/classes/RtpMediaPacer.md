[**werift**](../README.md)

***

[werift](../globals.md) / RtpMediaPacer

# Class: RtpMediaPacer\<T\>

Monotonic real-time pacer for frames with their own timestamps, such as
variable-frame-rate encoded video.

- Frame k is emitted at the absolute deadline
  `anchor.time + (dts(k) - anchor.dts) * 1000 / clockRate`, so timer
  lateness never accumulates. The RTP timestamp is
  `initialTimestamp + (pts(k) - pts(first frame))`, which keeps the source's
  frame spacing (including B-frame reordering).
- Frames are never skipped. When the emitted frame and the next queued frame
  are both overdue (a stall, or a producer that pushes a late batch), only
  the emitted frame is sent and the timeline is re-anchored to `now`, so the
  stall becomes added latency (`delay`) instead of a burst. A frame pushed
  after its deadline while the queue is empty is emitted immediately.
- `resume()` emits the next frame immediately if it became due while paused
  and re-anchors to it; the paused time is added to `delay`.
- `onTick` subscribers are invoked synchronously after the internal state has
  been updated. Returned promises are not awaited; use `queueLength` for
  backpressure on the producer side.

## Type Parameters

• **T** = `Buffer`

## Constructors

### new RtpMediaPacer()

> **new RtpMediaPacer**\<`T`\>(`options`): [`RtpMediaPacer`](RtpMediaPacer.md)\<`T`\>

#### Parameters

##### options

[`RtpMediaPacerOptions`](../interfaces/RtpMediaPacerOptions.md)

#### Returns

[`RtpMediaPacer`](RtpMediaPacer.md)\<`T`\>

## Properties

### clockRate

> `readonly` **clockRate**: `number`

***

### initialTimestamp

> `readonly` **initialTimestamp**: `number`

***

### onTick

> `readonly` **onTick**: [`Event`](Event.md)\<\[[`RtpMediaPacerTick`](../interfaces/RtpMediaPacerTick.md)\<`T`\>\]\>

## Accessors

### delay

#### Get Signature

> **get** **delay**(): `number`

Total time (ms) the timeline has been shifted so far.

##### Returns

`number`

***

### lastTick

#### Get Signature

> **get** **lastTick**(): `undefined` \| [`RtpMediaPacerTick`](../interfaces/RtpMediaPacerTick.md)\<`T`\>

The most recently emitted tick.

##### Returns

`undefined` \| [`RtpMediaPacerTick`](../interfaces/RtpMediaPacerTick.md)\<`T`\>

***

### queueLength

#### Get Signature

> **get** **queueLength**(): `number`

Frames pushed but not emitted yet.

##### Returns

`number`

***

### state

#### Get Signature

> **get** **state**(): [`RtpMediaClockState`](../type-aliases/RtpMediaClockState.md)

##### Returns

[`RtpMediaClockState`](../type-aliases/RtpMediaClockState.md)

## Methods

### pause()

> **pause**(): `void`

#### Returns

`void`

***

### push()

> **push**(`frame`, `timing`): `void`

Queues a frame. Frames may be pushed before `start()`.

#### Parameters

##### frame

`T`

##### timing

[`RtpMediaPacerFrameTiming`](../interfaces/RtpMediaPacerFrameTiming.md)

#### Returns

`void`

***

### resume()

> **resume**(): `void`

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

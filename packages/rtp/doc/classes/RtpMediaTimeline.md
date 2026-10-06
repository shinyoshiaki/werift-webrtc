[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / RtpMediaTimeline

# Class: RtpMediaTimeline

Pure, deterministic RTP media timeline.

All values are computed absolutely from the frame index, so no error
accumulates no matter how long the timeline runs.

## Constructors

### new RtpMediaTimeline()

> **new RtpMediaTimeline**(`options`): [`RtpMediaTimeline`](RtpMediaTimeline.md)

#### Parameters

##### options

[`RtpMediaTimelineOptions`](../interfaces/RtpMediaTimelineOptions.md)

#### Returns

[`RtpMediaTimeline`](RtpMediaTimeline.md)

## Properties

### clockRate

> `readonly` **clockRate**: `number`

***

### frameDurationMs

> `readonly` **frameDurationMs**: `number`

***

### frameSamples

> `readonly` **frameSamples**: `number`

***

### initialTimestamp

> `readonly` **initialTimestamp**: `number`

## Methods

### deadline()

> **deadline**(`anchor`, `frameIndex`): `number`

`anchor.time + (N - anchor.frameIndex) * frameDurationMs`

#### Parameters

##### anchor

[`RtpMediaTimelineAnchor`](../interfaces/RtpMediaTimelineAnchor.md)

##### frameIndex

`number`

#### Returns

`number`

***

### elapsedSamples()

> **elapsedSamples**(`frameIndex`): `number`

`round(N * frameSamples)`: samples elapsed from frame 0 to frame N.

#### Parameters

##### frameIndex

`number`

#### Returns

`number`

***

### latestFrameIndex()

> **latestFrameIndex**(`anchor`, `now`): `number`

Latest slot whose deadline has been reached at `now`.

#### Parameters

##### anchor

[`RtpMediaTimelineAnchor`](../interfaces/RtpMediaTimelineAnchor.md)

##### now

`number`

#### Returns

`number`

***

### resolveTick()

> **resolveTick**(`__namedParameters`): `undefined` \| [`RtpMediaClockTick`](../interfaces/RtpMediaClockTick.md)

Resolves the tick to emit at `now`.

Returns `undefined` when the deadline of `nextFrameIndex` has not been
reached yet. When several slots have elapsed, `stallPolicy: "skip"`
(default) returns only the latest reached slot and reports the slots in
between as `skippedFrames`; `"delay"` returns `nextFrameIndex` with its
original deadline, so `lateness` shows how far behind the clock is.

#### Parameters

##### \_\_namedParameters

###### anchor

[`RtpMediaTimelineAnchor`](../interfaces/RtpMediaTimelineAnchor.md)

###### lastFrameIndex?

`number`

Frame index of the previous tick, if any.

###### nextFrameIndex

`number`

###### now

`number`

###### stallPolicy?

[`RtpMediaClockStallPolicy`](../type-aliases/RtpMediaClockStallPolicy.md) = `"skip"`

#### Returns

`undefined` \| [`RtpMediaClockTick`](../interfaces/RtpMediaClockTick.md)

***

### timestamp()

> **timestamp**(`frameIndex`): `number`

`(initialTimestamp + elapsedSamples(N)) mod 2^32`

#### Parameters

##### frameIndex

`number`

#### Returns

`number`

[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / RtpMediaPacerTick

# Interface: RtpMediaPacerTick\<T\>

## Type Parameters

• **T**

## Properties

### deadline

> **deadline**: `number`

Scheduled monotonic time (ms) of this frame.

***

### delay

> **delay**: `number`

Total time (ms) the timeline has been shifted by stalls and pauses.

***

### dts

> **dts**: `number`

***

### frame

> **frame**: `T`

***

### frameIndex

> **frameIndex**: `number`

Number of frames emitted before this one.

***

### lateness

> **lateness**: `number`

`now - deadline` in ms.

***

### pts

> **pts**: `number`

***

### timestamp

> **timestamp**: `number`

RTP timestamp derived from `pts` (uint32, wrapped).

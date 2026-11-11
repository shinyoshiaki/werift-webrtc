[**werift**](../README.md)

***

[werift](../globals.md) / RtpMediaClockTick

# Interface: RtpMediaClockTick

## Properties

### deadline

> **deadline**: `number`

Scheduled monotonic time (ms) of this slot.

***

### elapsedSamples

> **elapsedSamples**: `number`

Samples elapsed since the previous tick, including skipped slots.

***

### frameIndex

> **frameIndex**: `number`

Slot number N of this tick.

***

### lateness

> **lateness**: `number`

`now - deadline` in ms.

***

### skippedFrames

> **skippedFrames**: `number`

Slots that were skipped instead of being emitted (normally 0).

***

### timestamp

> **timestamp**: `number`

RTP timestamp of the slot (uint32, wrapped).

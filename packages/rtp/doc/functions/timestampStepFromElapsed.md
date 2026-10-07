[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / timestampStepFromElapsed

# Function: timestampStepFromElapsed()

> **timestampStepFromElapsed**(`elapsedMs`, `clockRate`): `number`

Timestamp step for `switchSource()` that reflects a wall-clock gap at the
boundary. Returns at least 1 so the new source never reuses the last timestamp.

## Parameters

### elapsedMs

`number`

elapsed time since the last output packet

### clockRate

`number`

RTP clock rate (e.g. 90000 for video)

## Returns

`number`

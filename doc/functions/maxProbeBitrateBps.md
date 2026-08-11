[**werift**](../README.md)

***

[werift](../globals.md) / maxProbeBitrateBps

# Function: maxProbeBitrateBps()

> **maxProbeBitrateBps**(`cause`, `estimatedBitrateBps`, `configuredMaxBps`): `number`

Max probe target bitrate for this cause (libwebrtc InitiateProbing switch).
- kLossLimitedBweIncreasing → estimated × loss_limited_probe_scale (1.5)
- kDelayBasedLimited → no extra cap (only configured max)
- forbid causes → 0 (caller should not probe)

## Parameters

### cause

[`BandwidthLimitedCause`](../type-aliases/BandwidthLimitedCause.md)

### estimatedBitrateBps

`number`

### configuredMaxBps

`number` = `kMaxBitrateBps`

## Returns

`number`

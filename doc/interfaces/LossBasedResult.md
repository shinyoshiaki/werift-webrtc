[**werift**](../README.md)

***

[werift](../globals.md) / LossBasedResult

# Interface: LossBasedResult

pin `LossBasedBweV2::Result` plus an explicit [LossBasedResult.ready](LossBasedResult.md#ready).

## Properties

### bandwidthEstimateBps

> **bandwidthEstimateBps**: `number`

Published bandwidth. When `!ready` and delay is unset this is
`+Infinity` (pin `DataRate::PlusInfinity`), never the stale
uninitialized `current_best_estimate_`.

***

### ready

> **ready**: `boolean`

pin `IsReady()` — controller must not adopt the estimate until true.

***

### state

> **state**: [`LossBasedState`](../type-aliases/LossBasedState.md)

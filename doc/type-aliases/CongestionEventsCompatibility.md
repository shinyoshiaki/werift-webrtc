[**werift**](../README.md)

***

[werift](../globals.md) / CongestionEventsCompatibility

# Type Alias: CongestionEventsCompatibility

> **CongestionEventsCompatibility** = `object`

Congestion events kept on every estimator instance so
`sender.senderBWE.onCongestion` still type-checks after the BWE abstraction.
Only [LightweightBandwidthEstimator](../classes/LightweightBandwidthEstimator.md) fires them; GCC / disabled are no-ops.

Not part of [BandwidthEstimator](../interfaces/BandwidthEstimator.md). Prefer a `LightweightBandwidthEstimator`
assertion for new code. This surface may be removed in a future major.

## Properties

### ~~congestion~~

> **congestion**: `boolean`

#### Deprecated

Lightweight-only. Always false on GCC / disabled.

***

### ~~congestionScore~~

> **congestionScore**: `number`

#### Deprecated

Lightweight-only. Always 1 on GCC / disabled.

***

### ~~onCongestion~~

> `readonly` **onCongestion**: [`Event`](../classes/Event.md)\<\[`boolean`\]\>

#### Deprecated

Lightweight-only. No-op on GCC / disabled.

***

### ~~onCongestionScore~~

> `readonly` **onCongestionScore**: [`Event`](../classes/Event.md)\<\[`number`\]\>

#### Deprecated

Lightweight-only. No-op on GCC / disabled.

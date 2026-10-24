[**werift**](../README.md)

***

[werift](../globals.md) / LegacyCongestionCompatibility

# Type Alias: LegacyCongestionCompatibility

> **LegacyCongestionCompatibility**: `object`

Legacy congestion events kept on every estimator instance so
`sender.senderBWE.onCongestion` still type-checks after the BWE abstraction.
Only SenderBandwidthEstimator fires them; GCC / disabled are no-ops.

Not part of [BandwidthEstimator](../interfaces/BandwidthEstimator.md). Prefer a `SenderBandwidthEstimator`
assertion for new code. This surface may be removed in a future major.

## Type declaration

### ~~congestion~~

> **congestion**: `boolean`

#### Deprecated

Legacy-only. Always false on GCC / disabled.

### ~~congestionScore~~

> **congestionScore**: `number`

#### Deprecated

Legacy-only. Always 1 on GCC / disabled.

### ~~onCongestion~~

> `readonly` **onCongestion**: [`Event`](../classes/Event.md)\<\[`boolean`\]\>

#### Deprecated

Legacy-only. No-op on GCC / disabled.

### ~~onCongestionScore~~

> `readonly` **onCongestionScore**: [`Event`](../classes/Event.md)\<\[`number`\]\>

#### Deprecated

Legacy-only. No-op on GCC / disabled.

[**werift**](../README.md)

***

[werift](../globals.md) / BandwidthEstimatorNoopHooks

# Class: `abstract` BandwidthEstimatorNoopHooks

Shared no-op implementations of GCC send-path hooks.
[SenderBandwidthEstimator](LegacyCumulativeBandwidthEstimator.md) and [DisabledBandwidthEstimator](DisabledBandwidthEstimator.md) extend this.

## Extended by

- [`DisabledBandwidthEstimator`](DisabledBandwidthEstimator.md)
- [`LegacyCumulativeBandwidthEstimator`](LegacyCumulativeBandwidthEstimator.md)

## Constructors

### new BandwidthEstimatorNoopHooks()

> **new BandwidthEstimatorNoopHooks**(): [`BandwidthEstimatorNoopHooks`](BandwidthEstimatorNoopHooks.md)

#### Returns

[`BandwidthEstimatorNoopHooks`](BandwidthEstimatorNoopHooks.md)

## Properties

### \_compatCongestionScore

> `protected` **\_compatCongestionScore**: `number` = `1`

***

### ~~congestion~~

> **congestion**: `boolean` = `false`

#### Deprecated

Always false except on [SenderBandwidthEstimator](LegacyCumulativeBandwidthEstimator.md).

***

### ~~onCongestion~~

> `readonly` **onCongestion**: [`Event`](Event.md)\<\[`boolean`\]\>

#### Deprecated

No-op except on [SenderBandwidthEstimator](LegacyCumulativeBandwidthEstimator.md).

***

### ~~onCongestionScore~~

> `readonly` **onCongestionScore**: [`Event`](Event.md)\<\[`number`\]\>

#### Deprecated

No-op except on [SenderBandwidthEstimator](LegacyCumulativeBandwidthEstimator.md).

***

### onProbeClusterConfig

> `readonly` **onProbeClusterConfig**: [`Event`](Event.md)\<\[[`ProbeClusterConfig`](../interfaces/ProbeClusterConfig.md)\]\>

***

### probePaddingMaxBurst

> `readonly` **probePaddingMaxBurst**: `0` = `0`

***

### probePaddingPacketBytes

> `readonly` **probePaddingPacketBytes**: `0` = `0`

***

### processIntervalMs

> `readonly` **processIntervalMs**: `0` = `0`

## Accessors

### congestionScore

#### Get Signature

> **get** **congestionScore**(): `number`

##### Deprecated

Always 1 except on [SenderBandwidthEstimator](LegacyCumulativeBandwidthEstimator.md).

##### Returns

`number`

## Methods

### disposeNoopHooks()

> `protected` **disposeNoopHooks**(): `void`

#### Returns

`void`

***

### getPacingBitrateBps()

> **getPacingBitrateBps**(): `number`

#### Returns

`number`

***

### getPaddingBitrateBps()

> **getPaddingBitrateBps**(): `number`

#### Returns

`number`

***

### pendingLossPaddingPackets()

> **pendingLossPaddingPackets**(`_packetBytes`?): `number`

#### Parameters

##### \_packetBytes?

`number`

#### Returns

`number`

***

### pendingProbePaddingPackets()

> **pendingProbePaddingPackets**(`_packetBytes`?): `number`

#### Parameters

##### \_packetBytes?

`number`

#### Returns

`number`

***

### process()

> **process**(`_nowMs`): `void`

#### Parameters

##### \_nowMs

`number`

#### Returns

`void`

***

### reserveOutgoingProbe()

> **reserveOutgoingProbe**(`_nowMs`): `undefined` \| [`ProbeReservation`](../interfaces/ProbeReservation.md)

#### Parameters

##### \_nowMs

`number`

#### Returns

`undefined` \| [`ProbeReservation`](../interfaces/ProbeReservation.md)

***

### setNetworkAvailable()

> **setNetworkAvailable**(`_available`): `void`

#### Parameters

##### \_available

`boolean`

#### Returns

`void`

***

### setRoundTripTime()

> **setRoundTripTime**(`_rttMs`): `void`

#### Parameters

##### \_rttMs

`number`

#### Returns

`void`

***

### shouldTagProbePacket()

> **shouldTagProbePacket**(): `boolean`

#### Returns

`boolean`

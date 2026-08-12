[**werift**](../README.md)

***

[werift](../globals.md) / LinkCapacityEstimator

# Class: LinkCapacityEstimator

libwebrtc `LinkCapacityEstimator` (pin goog_cc/link_capacity_estimator).
Used by AimdRateControl to choose additive vs multiplicative increase and
to refine overuse decreases.

## Constructors

### new LinkCapacityEstimator()

> **new LinkCapacityEstimator**(): [`LinkCapacityEstimator`](LinkCapacityEstimator.md)

#### Returns

[`LinkCapacityEstimator`](LinkCapacityEstimator.md)

## Accessors

### deviationKbpsValue

#### Get Signature

> **get** **deviationKbpsValue**(): `number`

Diagnostics: current deviation_kbps_ (normalized variance).

##### Returns

`number`

## Methods

### estimateBps()

> **estimateBps**(): `number`

Estimated capacity in bps.

#### Returns

`number`

***

### hasEstimate()

> **hasEstimate**(): `boolean`

#### Returns

`boolean`

***

### lowerBoundBps()

> **lowerBoundBps**(): `number`

Lower bound bps (estimate − 3σ), or 0 if unknown.

#### Returns

`number`

***

### onOveruseDetected()

> **onOveruseDetected**(`acknowledgedRateBps`): `void`

#### Parameters

##### acknowledgedRateBps

`number`

#### Returns

`void`

***

### onProbeRate()

> **onProbeRate**(`probeRateBps`): `void`

#### Parameters

##### probeRateBps

`number`

#### Returns

`void`

***

### reset()

> **reset**(): `void`

pin `LinkCapacityEstimator::Reset` — clear capacity estimate only.
Deviation history is retained (used on AIMD throughput bound transitions).

#### Returns

`void`

***

### resetAll()

> **resetAll**(): `void`

Full estimator re-init (route change / GccBandwidthEstimator.reset).
Not the same as pin Reset() during AIMD state transitions.

#### Returns

`void`

***

### upperBoundBps()

> **upperBoundBps**(): `number`

Upper bound bps (estimate + 3σ), or +∞ if unknown.

#### Returns

`number`

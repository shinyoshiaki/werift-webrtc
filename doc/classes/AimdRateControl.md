[**werift**](../README.md)

***

[werift](../globals.md) / AimdRateControl

# Class: AimdRateControl

AIMD rate controller for the delay-based estimate (pin
`modules/remote_bitrate_estimator/aimd_rate_control.{h,cc}`).

Ports ChangeState / ChangeBitrate / MultiplicativeRateIncrease /
AdditiveRateIncrease / TimeToReduceFurther / GetNearMaxIncreaseRate.

RTT is **only** via [setRtt](AimdRateControl.md#setrtt) (RTCP / OnRoundTripTimeUpdate path) —
never from TWCC propagation RTT / RttBasedBackoff.

## Constructors

### new AimdRateControl()

> **new AimdRateControl**(): [`AimdRateControl`](AimdRateControl.md)

#### Returns

[`AimdRateControl`](AimdRateControl.md)

## Accessors

### controlState

#### Get Signature

> **get** **controlState**(): `RateControlState`

##### Returns

`RateControlState`

***

### rtt

#### Get Signature

> **get** **rtt**(): `number`

##### Returns

`number`

***

### targetBitrateBps

#### Get Signature

> **get** **targetBitrateBps**(): `number`

##### Returns

`number`

## Methods

### getNearMaxIncreaseRateBpsPerSecond()

> **getNearMaxIncreaseRateBpsPerSecond**(): `number`

pin `GetNearMaxIncreaseRateBpsPerSecond`:
response_time = (rtt + 100ms) * 2; min increase 4000 bps/s.

#### Returns

`number`

***

### initialTimeToReduceFurther()

> **initialTimeToReduceFurther**(`nowMs`): `boolean`

pin `InitialTimeToReduceFurther`.

#### Parameters

##### nowMs

`number`

#### Returns

`boolean`

***

### reset()

> **reset**(`startBps`): `void`

#### Parameters

##### startBps

`number` = `kDefaultStartBitrateBps`

#### Returns

`void`

***

### setEstimate()

> **setEstimate**(`bitrateBps`, `atTimeMs`): `void`

State-preserving estimate update (pin `AimdRateControl::SetEstimate`).
Used for valid probe results — does not wipe RTT or link-capacity history.

#### Parameters

##### bitrateBps

`number`

##### atTimeMs

`number`

#### Returns

`void`

***

### setInApplicationLimitedRegion()

> **setInApplicationLimitedRegion**(`inAlr`): `void`

#### Parameters

##### inAlr

`boolean`

#### Returns

`void`

***

### setMinBitrate()

> **setMinBitrate**(`minBps`): `void`

#### Parameters

##### minBps

`number`

#### Returns

`void`

***

### setNetworkStateEstimate()

> **setNetworkStateEstimate**(`linkCapacityUpperBps`, `linkCapacityLowerBps`): `void`

pin `AimdRateControl::SetNetworkStateEstimate`.
Non-finite / non-positive upper clears the estimate.

#### Parameters

##### linkCapacityUpperBps

`number`

##### linkCapacityLowerBps

`number` = `0`

#### Returns

`void`

***

### setRtt()

> **setRtt**(`rttMs`): `void`

pin `AimdRateControl::SetRtt` — RTCP / network-controller RTT only.
No clamp to 2000ms; TimeToReduceFurther clamps to [10, 200] ms internally.

#### Parameters

##### rttMs

`number`

#### Returns

`void`

***

### setStartBitrate()

> **setStartBitrate**(`startBps`): `void`

#### Parameters

##### startBps

`number`

#### Returns

`void`

***

### timeToReduceFurther()

> **timeToReduceFurther**(`nowMs`, `estimatedThroughputBps`): `boolean`

pin `TimeToReduceFurther`:
- allow after clamp(rtt, 10ms, 200ms) since last bitrate **change**
- or when estimated_throughput < 0.5 * LatestEstimate

#### Parameters

##### nowMs

`number`

##### estimatedThroughputBps

`number`

#### Returns

`boolean`

***

### update()

> **update**(`usage`, `acknowledgedBitrateBps`, `nowMs`): `number`

#### Parameters

##### usage

[`BandwidthUsage`](../type-aliases/BandwidthUsage.md)

overuse detector state

##### acknowledgedBitrateBps

`number`

estimated throughput R_hat (acked bitrate)

##### nowMs

`number`

feedback / wall clock ms

#### Returns

`number`

***

### validEstimate()

> **validEstimate**(): `boolean`

#### Returns

`boolean`

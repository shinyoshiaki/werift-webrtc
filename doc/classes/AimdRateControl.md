[**werift**](../README.md)

***

[werift](../globals.md) / AimdRateControl

# Class: AimdRateControl

AIMD rate controller for the delay-based estimate A_hat.

Aligns with libwebrtc `AimdRateControl` control points:
- Decrease at most once per RTT (`TimeToReduceFurther`), then hold
- Multiplicative increase in slow-start / far from max; additive near max
- Soft upper bound vs acknowledged throughput

## See

modules/congestion_controller/goog_cc/aimd_rate_control.cc

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

State-preserving estimate update (libwebrtc `AimdRateControl::SetEstimate`).
Used when applying a valid probe result — does **not** wipe RTT, max-bitrate
variance, or slow-start bookkeeping the way [reset](AimdRateControl.md#reset) does.

#### Parameters

##### bitrateBps

`number`

##### atTimeMs

`number`

#### Returns

`void`

***

### setRtt()

> **setRtt**(`rttMs`): `void`

#### Parameters

##### rttMs

`number`

#### Returns

`void`

***

### timeToReduceFurther()

> **timeToReduceFurther**(`nowMs`, `acknowledgedBitrateBps`): `boolean`

libwebrtc `TimeToReduceFurther`: allow another decrease after ≥ RTT, or
when measured throughput falls well below the current estimate.

#### Parameters

##### nowMs

`number`

##### acknowledgedBitrateBps

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

measured incoming / acked bitrate R_hat

##### nowMs

`number`

wall clock (or feedback timeline)

#### Returns

`number`

[**werift**](../README.md)

***

[werift](../globals.md) / AimdRateControl

# Class: AimdRateControl

AIMD rate controller for the delay-based estimate A_hat (draft §5.5).

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

### setRtt()

> **setRtt**(`rttMs`): `void`

#### Parameters

##### rttMs

`number`

#### Returns

`void`

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

wall clock

#### Returns

`number`

[**werift**](../README.md)

***

[werift](../globals.md) / AlrDetector

# Class: AlrDetector

pin `modules/congestion_controller/goog_cc/alr_detector`.

ALR starts when the send budget ratio exceeds
kAlrStartBudgetLevelRatio (underusing) and ends when it falls below
kAlrStopBudgetLevelRatio. Budget target is estimate ×
kAlrBandwidthUsageRatio.

Start time uses the sender clock (`sendMs`), matching pin Timestamp domain.

## Constructors

### new AlrDetector()

> **new AlrDetector**(): [`AlrDetector`](AlrDetector.md)

#### Returns

[`AlrDetector`](AlrDetector.md)

## Accessors

### inAlr

#### Get Signature

> **get** **inAlr**(): `boolean`

##### Returns

`boolean`

***

### startMs

#### Get Signature

> **get** **startMs**(): `undefined` \| `number`

Sender-clock time when the current ALR region started, if any.

##### Returns

`undefined` \| `number`

## Methods

### onBytesSent()

> **onBytesSent**(`bytes`, `sendMs`): `void`

#### Parameters

##### bytes

`number`

##### sendMs

`number`

#### Returns

`void`

***

### reset()

> **reset**(): `void`

#### Returns

`void`

***

### setEstimatedBitrate()

> **setEstimatedBitrate**(`bps`): `void`

#### Parameters

##### bps

`number`

#### Returns

`void`

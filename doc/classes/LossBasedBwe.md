[**werift**](../README.md)

***

[werift](../globals.md) / LossBasedBwe

# Class: LossBasedBwe

LossBasedBweV2-aligned controller
(`modules/congestion_controller/goog_cc/loss_based_bwe_v2.*`).

Implements observation window, candidate generation (factor / acked / delay),
loss probability model, Newton updates for inherent loss, and objective
ranking. Defaults mirror Chromium field-trial defaults where practical.

## Constructors

### new LossBasedBwe()

> **new LossBasedBwe**(): [`LossBasedBwe`](LossBasedBwe.md)

#### Returns

[`LossBasedBwe`](LossBasedBwe.md)

## Accessors

### averageLossRatio

#### Get Signature

> **get** **averageLossRatio**(): `number`

##### Returns

`number`

***

### inherentLossEstimate

#### Get Signature

> **get** **inherentLossEstimate**(): `number`

##### Returns

`number`

***

### lossState

#### Get Signature

> **get** **lossState**(): [`LossBasedState`](../type-aliases/LossBasedState.md)

##### Returns

[`LossBasedState`](../type-aliases/LossBasedState.md)

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

### setBitrateIfHigher()

> **setBitrateIfHigher**(`bps`): `void`

#### Parameters

##### bps

`number`

#### Returns

`void`

***

### update()

> **update**(`lossFraction`, `delayBasedBps`, `acknowledgedBps`, `packetCount`, `lostCount`, `_nowMs`, `batchBytes`, `sendDurationMs`): `number`

#### Parameters

##### lossFraction

`number`

unused except compatibility (prefer packet counts)

##### delayBasedBps

`number`

delay-based A_hat

##### acknowledgedBps

`number` = `0`

recent acked bitrate (TWCC-relative throughput)

##### packetCount

`number` = `0`

known packets in batch

##### lostCount

`number` = `0`

lost among known

##### \_nowMs

`number` = `0`

##### batchBytes

`number` = `0`

total sent bytes in batch

##### sendDurationMs

`number` = `0`

duration of this batch on the **send** timeline

#### Returns

`number`

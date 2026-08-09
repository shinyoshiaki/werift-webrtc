[**werift**](../README.md)

***

[werift](../globals.md) / LossBasedBwe

# Class: LossBasedBwe

LossBasedBweV2-aligned controller
(`modules/congestion_controller/goog_cc/loss_based_bwe_v2.*`).

- Partial observations accumulate until duration ≥ 250ms (lower bound)
- Estimates require ≥ 3 committed observations
- Loss probability: inherent + (1−inherent)×excess/sending (libwebrtc)
- Constants match Chromium field-trial defaults (lkgr)

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

### observationCount

#### Get Signature

> **get** **observationCount**(): `number`

Number of committed observations (for readiness tests).

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

### setBitrateIfHigher()

> **setBitrateIfHigher**(`bps`): `void`

#### Parameters

##### bps

`number`

#### Returns

`void`

***

### update()

> **update**(`lossFraction`, `delayBasedBps`, `acknowledgedBps`, `packetCount`, `lostCount`, `nowMs`, `batchBytes`, `sendDurationMs`): `number`

#### Parameters

##### lossFraction

`number`

fallback when packet counts are 0

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

##### nowMs

`number` = `0`

send-timeline reference (used for partial window start)

##### batchBytes

`number` = `0`

total sent bytes in batch

##### sendDurationMs

`number` = `0`

duration of this batch on the send timeline

#### Returns

`number`

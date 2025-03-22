[**werift-rtp**](../README.md) • **Docs**

***

[werift-rtp](../globals.md) / ReceiverEstimatedMaxBitrate

# Class: ReceiverEstimatedMaxBitrate

## Constructors

### new ReceiverEstimatedMaxBitrate()

> **new ReceiverEstimatedMaxBitrate**(`props`): [`ReceiverEstimatedMaxBitrate`](ReceiverEstimatedMaxBitrate.md)

#### Parameters

• **props**: `Partial`\<[`ReceiverEstimatedMaxBitrate`](ReceiverEstimatedMaxBitrate.md)\> = `{}`

#### Returns

[`ReceiverEstimatedMaxBitrate`](ReceiverEstimatedMaxBitrate.md)

## Properties

### bitrate

> **bitrate**: `bigint`

***

### brExp

> **brExp**: `number`

***

### brMantissa

> **brMantissa**: `number`

***

### count

> **count**: `number` = `ReceiverEstimatedMaxBitrate.count`

***

### length

> **length**: `number`

***

### mediaSsrc

> **mediaSsrc**: `number`

***

### senderSsrc

> **senderSsrc**: `number`

***

### ssrcFeedbacks

> **ssrcFeedbacks**: `number`[] = `[]`

***

### ssrcNum

> **ssrcNum**: `number` = `0`

***

### uniqueID

> `readonly` **uniqueID**: `string` = `"REMB"`

***

### count

> `static` **count**: `number` = `15`

## Methods

### serialize()

> **serialize**(): `Buffer`

#### Returns

`Buffer`

***

### deSerialize()

> `static` **deSerialize**(`data`): [`ReceiverEstimatedMaxBitrate`](ReceiverEstimatedMaxBitrate.md)

#### Parameters

• **data**: `Buffer`

#### Returns

[`ReceiverEstimatedMaxBitrate`](ReceiverEstimatedMaxBitrate.md)

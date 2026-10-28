[**werift**](../README.md)

***

[werift](../globals.md) / ReceiverEstimatedMaxBitrate

# Class: ReceiverEstimatedMaxBitrate

## Constructors

### Constructor

> **new ReceiverEstimatedMaxBitrate**(`props?`): `ReceiverEstimatedMaxBitrate`

#### Parameters

##### props?

`Partial`\<`ReceiverEstimatedMaxBitrate`\> = `{}`

#### Returns

`ReceiverEstimatedMaxBitrate`

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

> **serialize**(): `Buffer`\<`ArrayBuffer`\>

#### Returns

`Buffer`\<`ArrayBuffer`\>

***

### deSerialize()

> `static` **deSerialize**(`data`): `ReceiverEstimatedMaxBitrate`

#### Parameters

##### data

`Buffer`

#### Returns

`ReceiverEstimatedMaxBitrate`

[werift](../README.md) / [Exports](../modules.md) / ReceiverEstimatedMaxBitrate

# Class: ReceiverEstimatedMaxBitrate

## Table of contents

### Constructors

- [constructor](ReceiverEstimatedMaxBitrate.md#constructor)

### Properties

- [bitrate](ReceiverEstimatedMaxBitrate.md#bitrate)
- [brExp](ReceiverEstimatedMaxBitrate.md#brexp)
- [brMantissa](ReceiverEstimatedMaxBitrate.md#brmantissa)
- [count](ReceiverEstimatedMaxBitrate.md#count)
- [length](ReceiverEstimatedMaxBitrate.md#length)
- [mediaSsrc](ReceiverEstimatedMaxBitrate.md#mediassrc)
- [senderSsrc](ReceiverEstimatedMaxBitrate.md#senderssrc)
- [ssrcFeedbacks](ReceiverEstimatedMaxBitrate.md#ssrcfeedbacks)
- [ssrcNum](ReceiverEstimatedMaxBitrate.md#ssrcnum)
- [uniqueID](ReceiverEstimatedMaxBitrate.md#uniqueid)
- [count](ReceiverEstimatedMaxBitrate.md#count-1)

### Methods

- [serialize](ReceiverEstimatedMaxBitrate.md#serialize)
- [deSerialize](ReceiverEstimatedMaxBitrate.md#deserialize)

## Constructors

### constructor

• **new ReceiverEstimatedMaxBitrate**(`props?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`<[`ReceiverEstimatedMaxBitrate`](ReceiverEstimatedMaxBitrate.md)\> |

## Properties

### bitrate

• **bitrate**: `bigint`

___

### brExp

• **brExp**: `number`

___

### brMantissa

• **brMantissa**: `number`

___

### count

• **count**: `number` = `ReceiverEstimatedMaxBitrate.count`

___

### length

• **length**: `number`

___

### mediaSsrc

• **mediaSsrc**: `number`

___

### senderSsrc

• **senderSsrc**: `number`

___

### ssrcFeedbacks

• **ssrcFeedbacks**: `number`[] = `[]`

___

### ssrcNum

• **ssrcNum**: `number` = `0`

___

### uniqueID

• `Readonly` **uniqueID**: `string` = `"REMB"`

___

### count

▪ `Static` **count**: `number` = `15`

## Methods

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

___

### deSerialize

▸ `Static` **deSerialize**(`data`): [`ReceiverEstimatedMaxBitrate`](ReceiverEstimatedMaxBitrate.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |

#### Returns

[`ReceiverEstimatedMaxBitrate`](ReceiverEstimatedMaxBitrate.md)

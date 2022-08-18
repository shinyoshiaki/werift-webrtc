[werift](../README.md) / [Exports](../modules.md) / RtcpPayloadSpecificFeedback

# Class: RtcpPayloadSpecificFeedback

## Table of contents

### Constructors

- [constructor](RtcpPayloadSpecificFeedback.md#constructor)

### Properties

- [feedback](RtcpPayloadSpecificFeedback.md#feedback)
- [type](RtcpPayloadSpecificFeedback.md#type)
- [type](RtcpPayloadSpecificFeedback.md#type-1)

### Methods

- [serialize](RtcpPayloadSpecificFeedback.md#serialize)
- [deSerialize](RtcpPayloadSpecificFeedback.md#deserialize)

## Constructors

### constructor

• **new RtcpPayloadSpecificFeedback**(`props?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`<[`RtcpPayloadSpecificFeedback`](RtcpPayloadSpecificFeedback.md)\> |

## Properties

### feedback

• **feedback**: `Feedback`

___

### type

• `Readonly` **type**: ``206``

___

### type

▪ `Static` `Readonly` **type**: ``206``

## Methods

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

___

### deSerialize

▸ `Static` **deSerialize**(`data`, `header`): [`RtcpPayloadSpecificFeedback`](RtcpPayloadSpecificFeedback.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |
| `header` | [`RtcpHeader`](RtcpHeader.md) |

#### Returns

[`RtcpPayloadSpecificFeedback`](RtcpPayloadSpecificFeedback.md)

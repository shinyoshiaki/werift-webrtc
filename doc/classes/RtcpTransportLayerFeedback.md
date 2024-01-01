[werift](../README.md) / [Exports](../modules.md) / RtcpTransportLayerFeedback

# Class: RtcpTransportLayerFeedback

## Table of contents

### Constructors

- [constructor](RtcpTransportLayerFeedback.md#constructor)

### Properties

- [feedback](RtcpTransportLayerFeedback.md#feedback)
- [header](RtcpTransportLayerFeedback.md#header)
- [type](RtcpTransportLayerFeedback.md#type)
- [type](RtcpTransportLayerFeedback.md#type-1)

### Methods

- [serialize](RtcpTransportLayerFeedback.md#serialize)
- [deSerialize](RtcpTransportLayerFeedback.md#deserialize)

## Constructors

### constructor

• **new RtcpTransportLayerFeedback**(`props?`): [`RtcpTransportLayerFeedback`](RtcpTransportLayerFeedback.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`\<[`RtcpTransportLayerFeedback`](RtcpTransportLayerFeedback.md)\> |

#### Returns

[`RtcpTransportLayerFeedback`](RtcpTransportLayerFeedback.md)

## Properties

### feedback

• **feedback**: `Feedback`

___

### header

• **header**: [`RtcpHeader`](RtcpHeader.md)

___

### type

• `Readonly` **type**: ``205``

___

### type

▪ `Static` `Readonly` **type**: ``205``

## Methods

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

___

### deSerialize

▸ **deSerialize**(`data`, `header`): [`RtcpTransportLayerFeedback`](RtcpTransportLayerFeedback.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |
| `header` | [`RtcpHeader`](RtcpHeader.md) |

#### Returns

[`RtcpTransportLayerFeedback`](RtcpTransportLayerFeedback.md)

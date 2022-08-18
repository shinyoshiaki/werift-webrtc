[werift](../README.md) / [Exports](../modules.md) / RecvDelta

# Class: RecvDelta

## Table of contents

### Constructors

- [constructor](RecvDelta.md#constructor)

### Properties

- [delta](RecvDelta.md#delta)
- [parsed](RecvDelta.md#parsed)
- [type](RecvDelta.md#type)

### Methods

- [deSerialize](RecvDelta.md#deserialize)
- [parseDelta](RecvDelta.md#parsedelta)
- [serialize](RecvDelta.md#serialize)
- [deSerialize](RecvDelta.md#deserialize-1)

## Constructors

### constructor

• **new RecvDelta**(`props?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`<[`RecvDelta`](RecvDelta.md)\> |

## Properties

### delta

• **delta**: `number`

micro sec

___

### parsed

• **parsed**: `boolean` = `false`

___

### type

• `Optional` **type**: [`TypeTCCPacketReceivedSmallDelta`](../enums/PacketStatus.md#typetccpacketreceivedsmalldelta) \| [`TypeTCCPacketReceivedLargeDelta`](../enums/PacketStatus.md#typetccpacketreceivedlargedelta)

optional (If undefined, it will be set automatically.)

## Methods

### deSerialize

▸ **deSerialize**(`data`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |

#### Returns

`void`

___

### parseDelta

▸ **parseDelta**(): `void`

#### Returns

`void`

___

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

___

### deSerialize

▸ `Static` **deSerialize**(`data`): [`RecvDelta`](RecvDelta.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |

#### Returns

[`RecvDelta`](RecvDelta.md)

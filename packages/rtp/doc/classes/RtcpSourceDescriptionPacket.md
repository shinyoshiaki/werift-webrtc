[werift-rtp](../README.md) / [Exports](../modules.md) / RtcpSourceDescriptionPacket

# Class: RtcpSourceDescriptionPacket

## Table of contents

### Constructors

- [constructor](RtcpSourceDescriptionPacket.md#constructor)

### Properties

- [chunks](RtcpSourceDescriptionPacket.md#chunks)
- [type](RtcpSourceDescriptionPacket.md#type)
- [type](RtcpSourceDescriptionPacket.md#type-1)

### Accessors

- [length](RtcpSourceDescriptionPacket.md#length)

### Methods

- [serialize](RtcpSourceDescriptionPacket.md#serialize)
- [deSerialize](RtcpSourceDescriptionPacket.md#deserialize)

## Constructors

### constructor

• **new RtcpSourceDescriptionPacket**(`props`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`<[`RtcpSourceDescriptionPacket`](RtcpSourceDescriptionPacket.md)\> |

## Properties

### chunks

• **chunks**: [`SourceDescriptionChunk`](SourceDescriptionChunk.md)[] = `[]`

___

### type

• `Readonly` **type**: ``202``

___

### type

▪ `Static` `Readonly` **type**: ``202``

## Accessors

### length

• `get` **length**(): `number`

#### Returns

`number`

## Methods

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

___

### deSerialize

▸ `Static` **deSerialize**(`payload`, `header`): [`RtcpSourceDescriptionPacket`](RtcpSourceDescriptionPacket.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `payload` | `Buffer` |
| `header` | [`RtcpHeader`](RtcpHeader.md) |

#### Returns

[`RtcpSourceDescriptionPacket`](RtcpSourceDescriptionPacket.md)

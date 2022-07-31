[werift](../README.md) / [Exports](../modules.md) / RtcpSourceDescriptionPacket

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

#### Defined in

[packages/rtp/src/rtcp/sdes.ts:10](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/sdes.ts#L10)

## Properties

### chunks

• **chunks**: [`SourceDescriptionChunk`](SourceDescriptionChunk.md)[] = `[]`

#### Defined in

[packages/rtp/src/rtcp/sdes.ts:8](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/sdes.ts#L8)

___

### type

• `Readonly` **type**: ``202``

#### Defined in

[packages/rtp/src/rtcp/sdes.ts:7](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/sdes.ts#L7)

___

### type

▪ `Static` `Readonly` **type**: ``202``

#### Defined in

[packages/rtp/src/rtcp/sdes.ts:6](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/sdes.ts#L6)

## Accessors

### length

• `get` **length**(): `number`

#### Returns

`number`

#### Defined in

[packages/rtp/src/rtcp/sdes.ts:14](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/sdes.ts#L14)

## Methods

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

#### Defined in

[packages/rtp/src/rtcp/sdes.ts:20](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/sdes.ts#L20)

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

#### Defined in

[packages/rtp/src/rtcp/sdes.ts:32](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/sdes.ts#L32)

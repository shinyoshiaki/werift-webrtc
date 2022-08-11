[werift](../README.md) / [Exports](../modules.md) / SourceDescriptionItem

# Class: SourceDescriptionItem

## Table of contents

### Constructors

- [constructor](SourceDescriptionItem.md#constructor)

### Properties

- [text](SourceDescriptionItem.md#text)
- [type](SourceDescriptionItem.md#type)

### Accessors

- [length](SourceDescriptionItem.md#length)

### Methods

- [serialize](SourceDescriptionItem.md#serialize)
- [deSerialize](SourceDescriptionItem.md#deserialize)

## Constructors

### constructor

• **new SourceDescriptionItem**(`props`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`<[`SourceDescriptionItem`](SourceDescriptionItem.md)\> |

#### Defined in

[packages/rtp/src/rtcp/sdes.ts:90](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/sdes.ts#L90)

## Properties

### text

• **text**: `string`

#### Defined in

[packages/rtp/src/rtcp/sdes.ts:88](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/sdes.ts#L88)

___

### type

• **type**: `number`

#### Defined in

[packages/rtp/src/rtcp/sdes.ts:87](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/sdes.ts#L87)

## Accessors

### length

• `get` **length**(): `number`

#### Returns

`number`

#### Defined in

[packages/rtp/src/rtcp/sdes.ts:94](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/sdes.ts#L94)

## Methods

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

#### Defined in

[packages/rtp/src/rtcp/sdes.ts:98](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/sdes.ts#L98)

___

### deSerialize

▸ `Static` **deSerialize**(`data`): [`SourceDescriptionItem`](SourceDescriptionItem.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |

#### Returns

[`SourceDescriptionItem`](SourceDescriptionItem.md)

#### Defined in

[packages/rtp/src/rtcp/sdes.ts:106](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/sdes.ts#L106)

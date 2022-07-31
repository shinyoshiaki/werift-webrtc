[werift](../README.md) / [Exports](../modules.md) / SourceDescriptionChunk

# Class: SourceDescriptionChunk

## Table of contents

### Constructors

- [constructor](SourceDescriptionChunk.md#constructor)

### Properties

- [items](SourceDescriptionChunk.md#items)
- [source](SourceDescriptionChunk.md#source)

### Accessors

- [length](SourceDescriptionChunk.md#length)

### Methods

- [serialize](SourceDescriptionChunk.md#serialize)
- [deSerialize](SourceDescriptionChunk.md#deserialize)

## Constructors

### constructor

• **new SourceDescriptionChunk**(`props?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`<[`SourceDescriptionChunk`](SourceDescriptionChunk.md)\> |

#### Defined in

[packages/rtp/src/rtcp/sdes.ts:48](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/sdes.ts#L48)

## Properties

### items

• **items**: [`SourceDescriptionItem`](SourceDescriptionItem.md)[] = `[]`

#### Defined in

[packages/rtp/src/rtcp/sdes.ts:46](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/sdes.ts#L46)

___

### source

• **source**: `number`

#### Defined in

[packages/rtp/src/rtcp/sdes.ts:45](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/sdes.ts#L45)

## Accessors

### length

• `get` **length**(): `number`

#### Returns

`number`

#### Defined in

[packages/rtp/src/rtcp/sdes.ts:52](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/sdes.ts#L52)

## Methods

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

#### Defined in

[packages/rtp/src/rtcp/sdes.ts:60](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/sdes.ts#L60)

___

### deSerialize

▸ `Static` **deSerialize**(`data`): [`SourceDescriptionChunk`](SourceDescriptionChunk.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |

#### Returns

[`SourceDescriptionChunk`](SourceDescriptionChunk.md)

#### Defined in

[packages/rtp/src/rtcp/sdes.ts:70](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/sdes.ts#L70)

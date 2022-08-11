[werift](../README.md) / [Exports](../modules.md) / StatusVectorChunk

# Class: StatusVectorChunk

## Table of contents

### Constructors

- [constructor](StatusVectorChunk.md#constructor)

### Properties

- [symbolList](StatusVectorChunk.md#symbollist)
- [symbolSize](StatusVectorChunk.md#symbolsize)
- [type](StatusVectorChunk.md#type)

### Methods

- [serialize](StatusVectorChunk.md#serialize)
- [deSerialize](StatusVectorChunk.md#deserialize)

## Constructors

### constructor

• **new StatusVectorChunk**(`props?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`<[`StatusVectorChunk`](StatusVectorChunk.md)\> |

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:307](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/twcc.ts#L307)

## Properties

### symbolList

• **symbolList**: `number`[] = `[]`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:305](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/twcc.ts#L305)

___

### symbolSize

• **symbolSize**: `number`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:304](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/twcc.ts#L304)

___

### type

• **type**: `number`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:303](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/twcc.ts#L303)

## Methods

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:332](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/twcc.ts#L332)

___

### deSerialize

▸ `Static` **deSerialize**(`data`): [`StatusVectorChunk`](StatusVectorChunk.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |

#### Returns

[`StatusVectorChunk`](StatusVectorChunk.md)

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:311](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/twcc.ts#L311)

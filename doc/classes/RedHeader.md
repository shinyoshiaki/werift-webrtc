[werift](../README.md) / [Exports](../modules.md) / RedHeader

# Class: RedHeader

## Table of contents

### Constructors

- [constructor](RedHeader.md#constructor)

### Properties

- [fields](RedHeader.md#fields)

### Methods

- [serialize](RedHeader.md#serialize)
- [deSerialize](RedHeader.md#deserialize)

## Constructors

### constructor

• **new RedHeader**()

## Properties

### fields

• **fields**: `RedHeaderField`[] = `[]`

#### Defined in

[packages/rtp/src/rtp/red/packet.ts:79](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtp/red/packet.ts#L79)

## Methods

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

#### Defined in

[packages/rtp/src/rtp/red/packet.ts:108](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtp/red/packet.ts#L108)

___

### deSerialize

▸ `Static` **deSerialize**(`buf`): readonly [[`RedHeader`](RedHeader.md), `number`]

#### Parameters

| Name | Type |
| :------ | :------ |
| `buf` | `Buffer` |

#### Returns

readonly [[`RedHeader`](RedHeader.md), `number`]

#### Defined in

[packages/rtp/src/rtp/red/packet.ts:81](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtp/red/packet.ts#L81)

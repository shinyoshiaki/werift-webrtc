[werift](../README.md) / [Exports](../modules.md) / Red

# Class: Red

## Table of contents

### Constructors

- [constructor](Red.md#constructor)

### Properties

- [blocks](Red.md#blocks)
- [header](Red.md#header)

### Methods

- [serialize](Red.md#serialize)
- [deSerialize](Red.md#deserialize)

## Constructors

### constructor

• **new Red**()

## Properties

### blocks

• **blocks**: { `block`: `Buffer` ; `blockPT`: `number` ; `timestampOffset?`: `number`  }[] = `[]`

#### Defined in

[packages/rtp/src/rtp/red/packet.ts:22](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtp/red/packet.ts#L22)

___

### header

• **header**: [`RedHeader`](RedHeader.md)

#### Defined in

[packages/rtp/src/rtp/red/packet.ts:21](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtp/red/packet.ts#L21)

## Methods

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

#### Defined in

[packages/rtp/src/rtp/red/packet.ts:53](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtp/red/packet.ts#L53)

___

### deSerialize

▸ `Static` **deSerialize**(`bufferOrArrayBuffer`): [`Red`](Red.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `bufferOrArrayBuffer` | `Buffer` \| `ArrayBuffer` |

#### Returns

[`Red`](Red.md)

#### Defined in

[packages/rtp/src/rtp/red/packet.ts:29](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtp/red/packet.ts#L29)

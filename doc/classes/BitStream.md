[werift](../README.md) / [Exports](../modules.md) / BitStream

# Class: BitStream

## Table of contents

### Constructors

- [constructor](BitStream.md#constructor)

### Properties

- [bitsPending](BitStream.md#bitspending)
- [position](BitStream.md#position)
- [uint8Array](BitStream.md#uint8array)

### Methods

- [readBits](BitStream.md#readbits)
- [seekTo](BitStream.md#seekto)
- [writeBits](BitStream.md#writebits)

## Constructors

### constructor

• **new BitStream**(`uint8Array`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `uint8Array` | `Buffer` |

#### Defined in

[packages/common/src/binary.ts:204](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/common/src/binary.ts#L204)

## Properties

### bitsPending

• `Private` **bitsPending**: `number` = `0`

#### Defined in

[packages/common/src/binary.ts:202](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/common/src/binary.ts#L202)

___

### position

• `Private` **position**: `number` = `0`

#### Defined in

[packages/common/src/binary.ts:201](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/common/src/binary.ts#L201)

___

### uint8Array

• **uint8Array**: `Buffer`

#### Defined in

[packages/common/src/binary.ts:204](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/common/src/binary.ts#L204)

## Methods

### readBits

▸ **readBits**(`bits`, `bitBuffer?`): `any`

#### Parameters

| Name | Type |
| :------ | :------ |
| `bits` | `number` |
| `bitBuffer?` | `number` |

#### Returns

`any`

#### Defined in

[packages/common/src/binary.ts:243](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/common/src/binary.ts#L243)

___

### seekTo

▸ **seekTo**(`bitPos`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `bitPos` | `number` |

#### Returns

`void`

#### Defined in

[packages/common/src/binary.ts:268](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/common/src/binary.ts#L268)

___

### writeBits

▸ **writeBits**(`bits`, `value`): [`BitStream`](BitStream.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `bits` | `number` |
| `value` | `number` |

#### Returns

[`BitStream`](BitStream.md)

#### Defined in

[packages/common/src/binary.ts:206](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/common/src/binary.ts#L206)

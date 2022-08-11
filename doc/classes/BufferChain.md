[werift](../README.md) / [Exports](../modules.md) / BufferChain

# Class: BufferChain

## Table of contents

### Constructors

- [constructor](BufferChain.md#constructor)

### Properties

- [buffer](BufferChain.md#buffer)

### Methods

- [writeInt16BE](BufferChain.md#writeint16be)
- [writeUInt8](BufferChain.md#writeuint8)

## Constructors

### constructor

• **new BufferChain**(`size`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `size` | `number` |

#### Defined in

[packages/common/src/binary.ts:172](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/common/src/binary.ts#L172)

## Properties

### buffer

• **buffer**: `Buffer`

#### Defined in

[packages/common/src/binary.ts:170](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/common/src/binary.ts#L170)

## Methods

### writeInt16BE

▸ **writeInt16BE**(`value`, `offset?`): [`BufferChain`](BufferChain.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `value` | `number` |
| `offset?` | `number` |

#### Returns

[`BufferChain`](BufferChain.md)

#### Defined in

[packages/common/src/binary.ts:176](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/common/src/binary.ts#L176)

___

### writeUInt8

▸ **writeUInt8**(`value`, `offset?`): [`BufferChain`](BufferChain.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `value` | `number` |
| `offset?` | `number` |

#### Returns

[`BufferChain`](BufferChain.md)

#### Defined in

[packages/common/src/binary.ts:181](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/common/src/binary.ts#L181)

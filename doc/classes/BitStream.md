[werift](../README.md) / [Exports](../modules.md) / BitStream

# Class: BitStream

## Table of contents

### Constructors

- [constructor](BitStream.md#constructor)

### Properties

- [uint8Array](BitStream.md#uint8array)

### Methods

- [readBits](BitStream.md#readbits)
- [seekTo](BitStream.md#seekto)
- [writeBits](BitStream.md#writebits)

## Constructors

### constructor

• **new BitStream**(`uint8Array`): [`BitStream`](BitStream.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `uint8Array` | `Buffer` |

#### Returns

[`BitStream`](BitStream.md)

## Properties

### uint8Array

• **uint8Array**: `Buffer`

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

___

### seekTo

▸ **seekTo**(`bitPos`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `bitPos` | `number` |

#### Returns

`void`

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

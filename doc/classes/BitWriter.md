[werift](../README.md) / [Exports](../modules.md) / BitWriter

# Class: BitWriter

## Table of contents

### Constructors

- [constructor](BitWriter.md#constructor)

### Properties

- [value](BitWriter.md#value)

### Accessors

- [buffer](BitWriter.md#buffer)

### Methods

- [set](BitWriter.md#set)

## Constructors

### constructor

• **new BitWriter**(`bitLength`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `bitLength` | `number` |

#### Defined in

[packages/common/src/binary.ts:48](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/common/src/binary.ts#L48)

## Properties

### value

• **value**: `number` = `0`

#### Defined in

[packages/common/src/binary.ts:46](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/common/src/binary.ts#L46)

## Accessors

### buffer

• `get` **buffer**(): `Buffer`

#### Returns

`Buffer`

#### Defined in

[packages/common/src/binary.ts:57](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/common/src/binary.ts#L57)

## Methods

### set

▸ **set**(`size`, `startIndex`, `value`): [`BitWriter`](BitWriter.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `size` | `number` |
| `startIndex` | `number` |
| `value` | `number` |

#### Returns

[`BitWriter`](BitWriter.md)

#### Defined in

[packages/common/src/binary.ts:50](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/common/src/binary.ts#L50)

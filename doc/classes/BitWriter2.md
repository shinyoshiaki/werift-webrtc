[werift](../README.md) / [Exports](../modules.md) / BitWriter2

# Class: BitWriter2

## Table of contents

### Constructors

- [constructor](BitWriter2.md#constructor)

### Properties

- [\_value](BitWriter2.md#_value)
- [offset](BitWriter2.md#offset)

### Accessors

- [buffer](BitWriter2.md#buffer)
- [value](BitWriter2.md#value)

### Methods

- [set](BitWriter2.md#set)

## Constructors

### constructor

• **new BitWriter2**(`bitLength`)

各valueがオクテットを跨いではならない

#### Parameters

| Name | Type |
| :------ | :------ |
| `bitLength` | `number` |

#### Defined in

[packages/common/src/binary.ts:72](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/common/src/binary.ts#L72)

## Properties

### \_value

• `Private` **\_value**: `bigint`

#### Defined in

[packages/common/src/binary.ts:66](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/common/src/binary.ts#L66)

___

### offset

• **offset**: `bigint`

#### Defined in

[packages/common/src/binary.ts:67](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/common/src/binary.ts#L67)

## Accessors

### buffer

• `get` **buffer**(): `Buffer`

#### Returns

`Buffer`

#### Defined in

[packages/common/src/binary.ts:95](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/common/src/binary.ts#L95)

___

### value

• `get` **value**(): `number`

#### Returns

`number`

#### Defined in

[packages/common/src/binary.ts:91](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/common/src/binary.ts#L91)

## Methods

### set

▸ **set**(`value`, `size?`): [`BitWriter2`](BitWriter2.md)

#### Parameters

| Name | Type | Default value |
| :------ | :------ | :------ |
| `value` | `number` | `undefined` |
| `size` | `number` | `1` |

#### Returns

[`BitWriter2`](BitWriter2.md)

#### Defined in

[packages/common/src/binary.ts:81](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/common/src/binary.ts#L81)

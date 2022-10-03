[werift-rtp](../README.md) / [Exports](../modules.md) / BitWriter2

# Class: BitWriter2

## Table of contents

### Constructors

- [constructor](BitWriter2.md#constructor)

### Properties

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

| Name | Type | Description |
| :------ | :------ | :------ |
| `bitLength` | `number` | Max 32bit |

## Properties

### offset

• **offset**: `bigint`

## Accessors

### buffer

• `get` **buffer**(): `Buffer`

#### Returns

`Buffer`

___

### value

• `get` **value**(): `number`

#### Returns

`number`

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

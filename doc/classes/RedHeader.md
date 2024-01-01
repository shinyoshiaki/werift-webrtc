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

• **new RedHeader**(): [`RedHeader`](RedHeader.md)

#### Returns

[`RedHeader`](RedHeader.md)

## Properties

### fields

• **fields**: `RedHeaderField`[] = `[]`

## Methods

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

___

### deSerialize

▸ **deSerialize**(`buf`): readonly [[`RedHeader`](RedHeader.md), `number`]

#### Parameters

| Name | Type |
| :------ | :------ |
| `buf` | `Buffer` |

#### Returns

readonly [[`RedHeader`](RedHeader.md), `number`]

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

___

### header

• **header**: [`RedHeader`](RedHeader.md)

## Methods

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

___

### deSerialize

▸ `Static` **deSerialize**(`bufferOrArrayBuffer`): [`Red`](Red.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `bufferOrArrayBuffer` | `Buffer` \| `ArrayBuffer` |

#### Returns

[`Red`](Red.md)

[werift-rtp](../README.md) / [Exports](../modules.md) / StatusVectorChunk

# Class: StatusVectorChunk

## Table of contents

### Constructors

- [constructor](StatusVectorChunk.md#constructor)

### Properties

- [symbolList](StatusVectorChunk.md#symbollist)
- [symbolSize](StatusVectorChunk.md#symbolsize)
- [type](StatusVectorChunk.md#type)

### Methods

- [serialize](StatusVectorChunk.md#serialize)
- [deSerialize](StatusVectorChunk.md#deserialize)

## Constructors

### constructor

• **new StatusVectorChunk**(`props?`): [`StatusVectorChunk`](StatusVectorChunk.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`\<[`StatusVectorChunk`](StatusVectorChunk.md)\> |

#### Returns

[`StatusVectorChunk`](StatusVectorChunk.md)

## Properties

### symbolList

• **symbolList**: `number`[] = `[]`

___

### symbolSize

• **symbolSize**: `number`

___

### type

• **type**: `number`

## Methods

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

___

### deSerialize

▸ **deSerialize**(`data`): [`StatusVectorChunk`](StatusVectorChunk.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |

#### Returns

[`StatusVectorChunk`](StatusVectorChunk.md)

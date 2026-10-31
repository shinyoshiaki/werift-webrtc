[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / StatusVectorChunk

# Class: StatusVectorChunk

## Constructors

### Constructor

> **new StatusVectorChunk**(`props?`): `StatusVectorChunk`

#### Parameters

##### props?

`Partial`\<`StatusVectorChunk`\> = `{}`

#### Returns

`StatusVectorChunk`

## Properties

### symbolList

> **symbolList**: `number`[] = `[]`

***

### symbolSize

> **symbolSize**: `number`

***

### type

> **type**: `number`

## Methods

### serialize()

> **serialize**(): `Buffer`\<`ArrayBuffer`\>

#### Returns

`Buffer`\<`ArrayBuffer`\>

***

### deSerialize()

> `static` **deSerialize**(`data`): `StatusVectorChunk`

#### Parameters

##### data

`Buffer`

#### Returns

`StatusVectorChunk`

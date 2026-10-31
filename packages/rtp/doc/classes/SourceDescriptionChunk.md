[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / SourceDescriptionChunk

# Class: SourceDescriptionChunk

## Constructors

### Constructor

> **new SourceDescriptionChunk**(`props?`): `SourceDescriptionChunk`

#### Parameters

##### props?

`Partial`\<`SourceDescriptionChunk`\> = `{}`

#### Returns

`SourceDescriptionChunk`

## Properties

### items

> **items**: [`SourceDescriptionItem`](SourceDescriptionItem.md)[] = `[]`

***

### source

> **source**: `number`

## Accessors

### length

#### Get Signature

> **get** **length**(): `number`

##### Returns

`number`

## Methods

### serialize()

> **serialize**(): `Buffer`\<`ArrayBuffer`\>

#### Returns

`Buffer`\<`ArrayBuffer`\>

***

### deSerialize()

> `static` **deSerialize**(`data`): `SourceDescriptionChunk`

#### Parameters

##### data

`Buffer`

#### Returns

`SourceDescriptionChunk`

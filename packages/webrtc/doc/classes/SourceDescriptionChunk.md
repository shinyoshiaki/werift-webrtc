[**werift**](../README.md)

***

[werift](../globals.md) / SourceDescriptionChunk

# Class: SourceDescriptionChunk

## Constructors

### new SourceDescriptionChunk()

> **new SourceDescriptionChunk**(`props`): [`SourceDescriptionChunk`](SourceDescriptionChunk.md)

#### Parameters

##### props

`Partial`\<[`SourceDescriptionChunk`](SourceDescriptionChunk.md)\> = `{}`

#### Returns

[`SourceDescriptionChunk`](SourceDescriptionChunk.md)

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

> `static` **deSerialize**(`data`): [`SourceDescriptionChunk`](SourceDescriptionChunk.md)

#### Parameters

##### data

`Buffer`

#### Returns

[`SourceDescriptionChunk`](SourceDescriptionChunk.md)

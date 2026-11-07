[**werift**](../README.md)

***

[werift](../globals.md) / H265AnnexBParser

# Class: H265AnnexBParser

## Constructors

### Constructor

> **new H265AnnexBParser**(`data`): `H265AnnexBParser`

#### Parameters

##### data

`Buffer`

#### Returns

`H265AnnexBParser`

## Methods

### readAll()

> **readAll**(): `Buffer`\<`ArrayBufferLike`\>[]

#### Returns

`Buffer`\<`ArrayBufferLike`\>[]

***

### readNextNalu()

> **readNextNalu**(): `Buffer`\<`ArrayBufferLike`\> \| `null`

Returns next NAL unit without start code, or null at EOF.

#### Returns

`Buffer`\<`ArrayBufferLike`\> \| `null`

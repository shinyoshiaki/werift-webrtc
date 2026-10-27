[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / H265AnnexBParser

# Class: H265AnnexBParser

## Constructors

### new H265AnnexBParser()

> **new H265AnnexBParser**(`data`): [`H265AnnexBParser`](H265AnnexBParser.md)

#### Parameters

##### data

`Buffer`

#### Returns

[`H265AnnexBParser`](H265AnnexBParser.md)

## Methods

### readAll()

> **readAll**(): `Buffer`\<`ArrayBufferLike`\>[]

#### Returns

`Buffer`\<`ArrayBufferLike`\>[]

***

### readNextNalu()

> **readNextNalu**(): `null` \| `Buffer`\<`ArrayBufferLike`\>

Returns next NAL unit without start code, or null at EOF.

#### Returns

`null` \| `Buffer`\<`ArrayBufferLike`\>

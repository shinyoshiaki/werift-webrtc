[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / H264AnnexBNaluSplitter

# Class: H264AnnexBNaluSplitter

Local Annex-B parser (same algorithm as H265AnnexBParser / extra H264AnnexBParser).

## Constructors

### new H264AnnexBNaluSplitter()

> **new H264AnnexBNaluSplitter**(`data`): [`H264AnnexBNaluSplitter`](H264AnnexBNaluSplitter.md)

#### Parameters

##### data

`Buffer`

#### Returns

[`H264AnnexBNaluSplitter`](H264AnnexBNaluSplitter.md)

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

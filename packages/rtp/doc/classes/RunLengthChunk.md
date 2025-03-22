[**werift-rtp**](../README.md) • **Docs**

***

[werift-rtp](../globals.md) / RunLengthChunk

# Class: RunLengthChunk

## Constructors

### new RunLengthChunk()

> **new RunLengthChunk**(`props`): [`RunLengthChunk`](RunLengthChunk.md)

#### Parameters

• **props**: `Partial`\<[`RunLengthChunk`](RunLengthChunk.md)\> = `{}`

#### Returns

[`RunLengthChunk`](RunLengthChunk.md)

## Properties

### packetStatus

> **packetStatus**: [`PacketStatus`](../enumerations/PacketStatus.md)

***

### runLength

> **runLength**: `number`

13bit

***

### type

> **type**: [`TypeTCCRunLengthChunk`](../enumerations/PacketChunk.md#typetccrunlengthchunk)

## Methods

### results()

> **results**(`currentSequenceNumber`): [`PacketResult`](PacketResult.md)[]

#### Parameters

• **currentSequenceNumber**: `number`

#### Returns

[`PacketResult`](PacketResult.md)[]

***

### serialize()

> **serialize**(): `Buffer`

#### Returns

`Buffer`

***

### deSerialize()

> `static` **deSerialize**(`data`): [`RunLengthChunk`](RunLengthChunk.md)

#### Parameters

• **data**: `Buffer`

#### Returns

[`RunLengthChunk`](RunLengthChunk.md)

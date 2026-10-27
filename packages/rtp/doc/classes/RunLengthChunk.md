[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / RunLengthChunk

# Class: RunLengthChunk

## Constructors

### Constructor

> **new RunLengthChunk**(`props?`): `RunLengthChunk`

#### Parameters

##### props?

`Partial`\<`RunLengthChunk`\> = `{}`

#### Returns

`RunLengthChunk`

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

Expand this run into `runLength` packet results starting after
`currentSequenceNumber` (caller passes last assigned seq, or
`baseSequenceNumber - 1` for the first chunk).

#### Parameters

##### currentSequenceNumber

`number`

#### Returns

[`PacketResult`](PacketResult.md)[]

***

### serialize()

> **serialize**(): `Buffer`\<`ArrayBuffer`\>

#### Returns

`Buffer`\<`ArrayBuffer`\>

***

### deSerialize()

> `static` **deSerialize**(`data`): `RunLengthChunk`

#### Parameters

##### data

`Buffer`

#### Returns

`RunLengthChunk`

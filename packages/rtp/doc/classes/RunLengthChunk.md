[werift-rtp](../README.md) / [Exports](../modules.md) / RunLengthChunk

# Class: RunLengthChunk

## Table of contents

### Constructors

- [constructor](RunLengthChunk.md#constructor)

### Properties

- [packetStatus](RunLengthChunk.md#packetstatus)
- [runLength](RunLengthChunk.md#runlength)
- [type](RunLengthChunk.md#type)

### Methods

- [results](RunLengthChunk.md#results)
- [serialize](RunLengthChunk.md#serialize)
- [deSerialize](RunLengthChunk.md#deserialize)

## Constructors

### constructor

• **new RunLengthChunk**(`props?`): [`RunLengthChunk`](RunLengthChunk.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`\<[`RunLengthChunk`](RunLengthChunk.md)\> |

#### Returns

[`RunLengthChunk`](RunLengthChunk.md)

## Properties

### packetStatus

• **packetStatus**: [`PacketStatus`](../enums/PacketStatus.md)

___

### runLength

• **runLength**: `number`

13bit

___

### type

• **type**: [`TypeTCCRunLengthChunk`](../enums/PacketChunk.md#typetccrunlengthchunk)

## Methods

### results

▸ **results**(`currentSequenceNumber`): [`PacketResult`](PacketResult.md)[]

#### Parameters

| Name | Type |
| :------ | :------ |
| `currentSequenceNumber` | `number` |

#### Returns

[`PacketResult`](PacketResult.md)[]

___

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

___

### deSerialize

▸ **deSerialize**(`data`): [`RunLengthChunk`](RunLengthChunk.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |

#### Returns

[`RunLengthChunk`](RunLengthChunk.md)

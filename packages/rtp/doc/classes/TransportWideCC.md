[werift-rtp](../README.md) / [Exports](../modules.md) / TransportWideCC

# Class: TransportWideCC

## Table of contents

### Constructors

- [constructor](TransportWideCC.md#constructor)

### Properties

- [baseSequenceNumber](TransportWideCC.md#basesequencenumber)
- [count](TransportWideCC.md#count)
- [fbPktCount](TransportWideCC.md#fbpktcount)
- [header](TransportWideCC.md#header)
- [length](TransportWideCC.md#length)
- [mediaSourceSsrc](TransportWideCC.md#mediasourcessrc)
- [packetChunks](TransportWideCC.md#packetchunks)
- [packetStatusCount](TransportWideCC.md#packetstatuscount)
- [recvDeltas](TransportWideCC.md#recvdeltas)
- [referenceTime](TransportWideCC.md#referencetime)
- [senderSsrc](TransportWideCC.md#senderssrc)
- [count](TransportWideCC.md#count-1)

### Accessors

- [packetResults](TransportWideCC.md#packetresults)

### Methods

- [serialize](TransportWideCC.md#serialize)
- [deSerialize](TransportWideCC.md#deserialize)

## Constructors

### constructor

• **new TransportWideCC**(`props?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`<[`TransportWideCC`](TransportWideCC.md)\> |

## Properties

### baseSequenceNumber

• **baseSequenceNumber**: `number`

___

### count

• **count**: `number` = `TransportWideCC.count`

___

### fbPktCount

• **fbPktCount**: `number`

___

### header

• **header**: [`RtcpHeader`](RtcpHeader.md)

___

### length

• **length**: `number` = `2`

___

### mediaSourceSsrc

• **mediaSourceSsrc**: `number`

___

### packetChunks

• **packetChunks**: ([`RunLengthChunk`](RunLengthChunk.md) \| [`StatusVectorChunk`](StatusVectorChunk.md))[] = `[]`

___

### packetStatusCount

• **packetStatusCount**: `number`

___

### recvDeltas

• **recvDeltas**: [`RecvDelta`](RecvDelta.md)[] = `[]`

___

### referenceTime

• **referenceTime**: `number`

24bit multiples of 64ms

___

### senderSsrc

• **senderSsrc**: `number`

___

### count

▪ `Static` **count**: `number` = `15`

## Accessors

### packetResults

• `get` **packetResults**(): [`PacketResult`](PacketResult.md)[]

#### Returns

[`PacketResult`](PacketResult.md)[]

## Methods

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

___

### deSerialize

▸ `Static` **deSerialize**(`data`, `header`): [`TransportWideCC`](TransportWideCC.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |
| `header` | [`RtcpHeader`](RtcpHeader.md) |

#### Returns

[`TransportWideCC`](TransportWideCC.md)

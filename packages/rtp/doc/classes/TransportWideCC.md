[**werift-rtp**](../README.md) • **Docs**

***

[werift-rtp](../globals.md) / TransportWideCC

# Class: TransportWideCC

## Constructors

### new TransportWideCC()

> **new TransportWideCC**(`props`): [`TransportWideCC`](TransportWideCC.md)

#### Parameters

• **props**: `Partial`\<[`TransportWideCC`](TransportWideCC.md)\> = `{}`

#### Returns

[`TransportWideCC`](TransportWideCC.md)

## Properties

### baseSequenceNumber

> **baseSequenceNumber**: `number`

***

### count

> **count**: `number` = `TransportWideCC.count`

***

### fbPktCount

> **fbPktCount**: `number`

***

### header

> **header**: [`RtcpHeader`](RtcpHeader.md)

***

### length

> **length**: `number` = `2`

***

### mediaSourceSsrc

> **mediaSourceSsrc**: `number`

***

### packetChunks

> **packetChunks**: ([`RunLengthChunk`](RunLengthChunk.md) \| [`StatusVectorChunk`](StatusVectorChunk.md))[] = `[]`

***

### packetStatusCount

> **packetStatusCount**: `number`

***

### recvDeltas

> **recvDeltas**: [`RecvDelta`](RecvDelta.md)[] = `[]`

***

### referenceTime

> **referenceTime**: `number`

24bit multiples of 64ms

***

### senderSsrc

> **senderSsrc**: `number`

***

### count

> `static` **count**: `number` = `15`

## Accessors

### packetResults

> `get` **packetResults**(): [`PacketResult`](PacketResult.md)[]

#### Returns

[`PacketResult`](PacketResult.md)[]

## Methods

### serialize()

> **serialize**(): `Buffer`

#### Returns

`Buffer`

***

### deSerialize()

> `static` **deSerialize**(`data`, `header`): [`TransportWideCC`](TransportWideCC.md)

#### Parameters

• **data**: `Buffer`

• **header**: [`RtcpHeader`](RtcpHeader.md)

#### Returns

[`TransportWideCC`](TransportWideCC.md)

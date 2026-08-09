[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / TransportWideCC

# Class: TransportWideCC

## Constructors

### new TransportWideCC()

> **new TransportWideCC**(`props`): [`TransportWideCC`](TransportWideCC.md)

#### Parameters

##### props

`Partial`\<[`TransportWideCC`](TransportWideCC.md)\> = `{}`

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

#### Get Signature

> **get** **packetResults**(): [`PacketResult`](PacketResult.md)[]

Expand packet status chunks into per-packet results with a single
sequence cursor and recv-delta cursor (draft-holmer TWCC).

Handles both [RunLengthChunk](RunLengthChunk.md) and [StatusVectorChunk](StatusVectorChunk.md),
and advances the sequence across chunk boundaries.

##### Returns

[`PacketResult`](PacketResult.md)[]

## Methods

### serialize()

> **serialize**(): `Buffer`\<`ArrayBuffer`\>

#### Returns

`Buffer`\<`ArrayBuffer`\>

***

### deSerialize()

> `static` **deSerialize**(`data`, `header`): [`TransportWideCC`](TransportWideCC.md)

#### Parameters

##### data

`Buffer`

##### header

[`RtcpHeader`](RtcpHeader.md)

#### Returns

[`TransportWideCC`](TransportWideCC.md)

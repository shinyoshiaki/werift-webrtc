[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / TransportWideCC

# Class: TransportWideCC

## Constructors

### Constructor

> **new TransportWideCC**(`props?`): `TransportWideCC`

#### Parameters

##### props?

`Partial`\<`TransportWideCC`\> = `{}`

#### Returns

`TransportWideCC`

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

##### Returns

[`PacketResult`](PacketResult.md)[]

## Methods

### serialize()

> **serialize**(): `Buffer`\<`ArrayBuffer`\>

#### Returns

`Buffer`\<`ArrayBuffer`\>

***

### deSerialize()

> `static` **deSerialize**(`data`, `header`): `TransportWideCC`

#### Parameters

##### data

`Buffer`

##### header

[`RtcpHeader`](RtcpHeader.md)

#### Returns

`TransportWideCC`

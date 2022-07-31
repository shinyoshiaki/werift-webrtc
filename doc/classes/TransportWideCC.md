[werift](../README.md) / [Exports](../modules.md) / TransportWideCC

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

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:60](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/twcc.ts#L60)

## Properties

### baseSequenceNumber

• **baseSequenceNumber**: `number`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:51](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/twcc.ts#L51)

___

### count

• **count**: `number` = `TransportWideCC.count`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:46](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/twcc.ts#L46)

___

### fbPktCount

• **fbPktCount**: `number`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:55](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/twcc.ts#L55)

___

### header

• **header**: [`RtcpHeader`](RtcpHeader.md)

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:58](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/twcc.ts#L58)

___

### length

• **length**: `number` = `2`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:47](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/twcc.ts#L47)

___

### mediaSourceSsrc

• **mediaSourceSsrc**: `number`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:50](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/twcc.ts#L50)

___

### packetChunks

• **packetChunks**: ([`RunLengthChunk`](RunLengthChunk.md) \| [`StatusVectorChunk`](StatusVectorChunk.md))[] = `[]`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:56](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/twcc.ts#L56)

___

### packetStatusCount

• **packetStatusCount**: `number`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:52](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/twcc.ts#L52)

___

### recvDeltas

• **recvDeltas**: [`RecvDelta`](RecvDelta.md)[] = `[]`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:57](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/twcc.ts#L57)

___

### referenceTime

• **referenceTime**: `number`

24bit multiples of 64ms

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:54](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/twcc.ts#L54)

___

### senderSsrc

• **senderSsrc**: `number`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:49](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/twcc.ts#L49)

___

### count

▪ `Static` **count**: `number` = `15`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:45](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/twcc.ts#L45)

## Accessors

### packetResults

• `get` **packetResults**(): [`PacketResult`](PacketResult.md)[]

#### Returns

[`PacketResult`](PacketResult.md)[]

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:227](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/twcc.ts#L227)

## Methods

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:182](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/twcc.ts#L182)

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

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:71](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/twcc.ts#L71)

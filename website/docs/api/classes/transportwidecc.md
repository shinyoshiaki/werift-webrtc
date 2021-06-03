---
id: "transportwidecc"
title: "Class: TransportWideCC"
sidebar_label: "TransportWideCC"
sidebar_position: 0
custom_edit_url: null
---

## Constructors

### constructor

• **new TransportWideCC**(`props?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`<[TransportWideCC](transportwidecc.md)\> |

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:54](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/rtpfb/twcc.ts#L54)

## Properties

### baseSequenceNumber

• **baseSequenceNumber**: `number`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:47](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/rtpfb/twcc.ts#L47)

___

### count

• **count**: `number`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:42](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/rtpfb/twcc.ts#L42)

___

### fbPktCount

• **fbPktCount**: `number`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:51](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/rtpfb/twcc.ts#L51)

___

### header

• **header**: [RtcpHeader](rtcpheader.md)

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:54](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/rtpfb/twcc.ts#L54)

___

### length

• **length**: `number` = 2

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:43](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/rtpfb/twcc.ts#L43)

___

### mediaSourceSsrc

• **mediaSourceSsrc**: `number`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:46](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/rtpfb/twcc.ts#L46)

___

### packetChunks

• **packetChunks**: ([RunLengthChunk](runlengthchunk.md) \| [StatusVectorChunk](statusvectorchunk.md))[] = []

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:52](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/rtpfb/twcc.ts#L52)

___

### packetStatusCount

• **packetStatusCount**: `number`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:48](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/rtpfb/twcc.ts#L48)

___

### recvDeltas

• **recvDeltas**: [RecvDelta](recvdelta.md)[] = []

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:53](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/rtpfb/twcc.ts#L53)

___

### referenceTime

• **referenceTime**: `number`

24bit multiples of 64ms

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:50](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/rtpfb/twcc.ts#L50)

___

### senderSsrc

• **senderSsrc**: `number`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:45](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/rtpfb/twcc.ts#L45)

___

### count

▪ `Static` **count**: `number` = 15

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:41](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/rtpfb/twcc.ts#L41)

## Accessors

### packetResults

• `get` **packetResults**(): `PacketResult`[]

#### Returns

`PacketResult`[]

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:223](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/rtpfb/twcc.ts#L223)

## Methods

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:178](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/rtpfb/twcc.ts#L178)

___

### deSerialize

▸ `Static` **deSerialize**(`data`, `header`): [TransportWideCC](transportwidecc.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |
| `header` | [RtcpHeader](rtcpheader.md) |

#### Returns

[TransportWideCC](transportwidecc.md)

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:67](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/rtpfb/twcc.ts#L67)

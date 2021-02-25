---
id: "transportwidecc"
title: "Class: TransportWideCC"
sidebar_label: "TransportWideCC"
custom_edit_url: null
hide_title: true
---

# Class: TransportWideCC

## Constructors

### constructor

\+ **new TransportWideCC**(`props?`: *Partial*<[*TransportWideCC*](transportwidecc.md)\>): [*TransportWideCC*](transportwidecc.md)

#### Parameters:

Name | Type |
:------ | :------ |
`props` | *Partial*<[*TransportWideCC*](transportwidecc.md)\> |

**Returns:** [*TransportWideCC*](transportwidecc.md)

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:50](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/rtp/src/rtcp/rtpfb/twcc.ts#L50)

## Properties

### baseSequenceNumber

• **baseSequenceNumber**: *number*

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:43](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/rtp/src/rtcp/rtpfb/twcc.ts#L43)

___

### count

• **count**: *number*

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:38](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/rtp/src/rtcp/rtpfb/twcc.ts#L38)

___

### fbPktCount

• **fbPktCount**: *number*

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:47](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/rtp/src/rtcp/rtpfb/twcc.ts#L47)

___

### header

• **header**: [*RtcpHeader*](rtcpheader.md)

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:50](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/rtp/src/rtcp/rtpfb/twcc.ts#L50)

___

### length

• **length**: *number*= 2

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:39](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/rtp/src/rtcp/rtpfb/twcc.ts#L39)

___

### mediaSourceSsrc

• **mediaSourceSsrc**: *number*

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:42](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/rtp/src/rtcp/rtpfb/twcc.ts#L42)

___

### packetChunks

• **packetChunks**: ([*RunLengthChunk*](runlengthchunk.md) \| [*StatusVectorChunk*](statusvectorchunk.md))[]

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:48](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/rtp/src/rtcp/rtpfb/twcc.ts#L48)

___

### packetStatusCount

• **packetStatusCount**: *number*

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:44](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/rtp/src/rtcp/rtpfb/twcc.ts#L44)

___

### recvDeltas

• **recvDeltas**: [*RecvDelta*](recvdelta.md)[]

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:49](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/rtp/src/rtcp/rtpfb/twcc.ts#L49)

___

### referenceTime

• **referenceTime**: *number*

24bit multiples of 64ms

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:46](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/rtp/src/rtcp/rtpfb/twcc.ts#L46)

___

### senderSsrc

• **senderSsrc**: *number*

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:41](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/rtp/src/rtcp/rtpfb/twcc.ts#L41)

___

### count

▪ `Static` **count**: *number*= 15

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:37](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/rtp/src/rtcp/rtpfb/twcc.ts#L37)

## Accessors

### packetResults

• get **packetResults**(): *PacketResult*[]

**Returns:** *PacketResult*[]

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:219](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/rtp/src/rtcp/rtpfb/twcc.ts#L219)

## Methods

### serialize

▸ **serialize**(): *Buffer*

**Returns:** *Buffer*

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:174](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/rtp/src/rtcp/rtpfb/twcc.ts#L174)

___

### deSerialize

▸ `Static`**deSerialize**(`data`: *Buffer*, `header`: [*RtcpHeader*](rtcpheader.md)): [*TransportWideCC*](transportwidecc.md)

#### Parameters:

Name | Type |
:------ | :------ |
`data` | *Buffer* |
`header` | [*RtcpHeader*](rtcpheader.md) |

**Returns:** [*TransportWideCC*](transportwidecc.md)

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:63](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/rtp/src/rtcp/rtpfb/twcc.ts#L63)

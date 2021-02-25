---
id: "rtcprrpacket"
title: "Class: RtcpRrPacket"
sidebar_label: "RtcpRrPacket"
custom_edit_url: null
hide_title: true
---

# Class: RtcpRrPacket

## Constructors

### constructor

\+ **new RtcpRrPacket**(`props?`: *Partial*<[*RtcpRrPacket*](rtcprrpacket.md)\>): [*RtcpRrPacket*](rtcprrpacket.md)

#### Parameters:

Name | Type |
:------ | :------ |
`props` | *Partial*<[*RtcpRrPacket*](rtcprrpacket.md)\> |

**Returns:** [*RtcpRrPacket*](rtcprrpacket.md)

Defined in: [rtp/src/rtcp/rr.ts:9](https://github.com/shinyoshiaki/werift-webrtc/blob/4277d59/packages/rtp/src/rtcp/rr.ts#L9)

## Properties

### reports

• **reports**: [*RtcpReceiverInfo*](rtcpreceiverinfo.md)[]

Defined in: [rtp/src/rtcp/rr.ts:7](https://github.com/shinyoshiaki/werift-webrtc/blob/4277d59/packages/rtp/src/rtcp/rr.ts#L7)

___

### ssrc

• **ssrc**: *number*= 0

Defined in: [rtp/src/rtcp/rr.ts:6](https://github.com/shinyoshiaki/werift-webrtc/blob/4277d59/packages/rtp/src/rtcp/rr.ts#L6)

___

### type

• **type**: *number*

Defined in: [rtp/src/rtcp/rr.ts:9](https://github.com/shinyoshiaki/werift-webrtc/blob/4277d59/packages/rtp/src/rtcp/rr.ts#L9)

___

### type

▪ `Static` **type**: *number*= 201

Defined in: [rtp/src/rtcp/rr.ts:8](https://github.com/shinyoshiaki/werift-webrtc/blob/4277d59/packages/rtp/src/rtcp/rr.ts#L8)

## Methods

### serialize

▸ **serialize**(): *Buffer*

**Returns:** *Buffer*

Defined in: [rtp/src/rtcp/rr.ts:15](https://github.com/shinyoshiaki/werift-webrtc/blob/4277d59/packages/rtp/src/rtcp/rr.ts#L15)

___

### deSerialize

▸ `Static`**deSerialize**(`data`: *Buffer*, `count`: *number*): [*RtcpRrPacket*](rtcprrpacket.md)

#### Parameters:

Name | Type |
:------ | :------ |
`data` | *Buffer* |
`count` | *number* |

**Returns:** [*RtcpRrPacket*](rtcprrpacket.md)

Defined in: [rtp/src/rtcp/rr.ts:29](https://github.com/shinyoshiaki/werift-webrtc/blob/4277d59/packages/rtp/src/rtcp/rr.ts#L29)

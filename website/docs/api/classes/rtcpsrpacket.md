---
id: "rtcpsrpacket"
title: "Class: RtcpSrPacket"
sidebar_label: "RtcpSrPacket"
custom_edit_url: null
hide_title: true
---

# Class: RtcpSrPacket

## Constructors

### constructor

\+ **new RtcpSrPacket**(`props?`: *Partial*<[*RtcpSrPacket*](rtcpsrpacket.md)\>): [*RtcpSrPacket*](rtcpsrpacket.md)

#### Parameters:

Name | Type | Default value |
:------ | :------ | :------ |
`props` | *Partial*<[*RtcpSrPacket*](rtcpsrpacket.md)\> | {} |

**Returns:** [*RtcpSrPacket*](rtcpsrpacket.md)

Defined in: [rtp/src/rtcp/sr.ts:11](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/rtp/src/rtcp/sr.ts#L11)

## Properties

### reports

• **reports**: [*RtcpReceiverInfo*](rtcpreceiverinfo.md)[]= []

Defined in: [rtp/src/rtcp/sr.ts:9](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/rtp/src/rtcp/sr.ts#L9)

___

### senderInfo

• **senderInfo**: [*RtcpSenderInfo*](rtcpsenderinfo.md)

Defined in: [rtp/src/rtcp/sr.ts:8](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/rtp/src/rtcp/sr.ts#L8)

___

### ssrc

• **ssrc**: *number*= 0

Defined in: [rtp/src/rtcp/sr.ts:7](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/rtp/src/rtcp/sr.ts#L7)

___

### type

• **type**: *number*

Defined in: [rtp/src/rtcp/sr.ts:11](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/rtp/src/rtcp/sr.ts#L11)

___

### type

▪ `Static` **type**: *number*= 200

Defined in: [rtp/src/rtcp/sr.ts:10](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/rtp/src/rtcp/sr.ts#L10)

## Methods

### serialize

▸ **serialize**(): *Buffer*

**Returns:** *Buffer*

Defined in: [rtp/src/rtcp/sr.ts:17](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/rtp/src/rtcp/sr.ts#L17)

___

### deSerialize

▸ `Static`**deSerialize**(`payload`: *Buffer*, `count`: *number*): [*RtcpSrPacket*](rtcpsrpacket.md)

#### Parameters:

Name | Type |
:------ | :------ |
`payload` | *Buffer* |
`count` | *number* |

**Returns:** [*RtcpSrPacket*](rtcpsrpacket.md)

Defined in: [rtp/src/rtcp/sr.ts:33](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/rtp/src/rtcp/sr.ts#L33)

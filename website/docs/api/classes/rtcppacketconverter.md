---
id: "rtcppacketconverter"
title: "Class: RtcpPacketConverter"
sidebar_label: "RtcpPacketConverter"
custom_edit_url: null
hide_title: true
---

# Class: RtcpPacketConverter

## Constructors

### constructor

\+ **new RtcpPacketConverter**(): [*RtcpPacketConverter*](rtcppacketconverter.md)

**Returns:** [*RtcpPacketConverter*](rtcppacketconverter.md)

## Methods

### deSerialize

▸ `Static`**deSerialize**(`data`: *Buffer*): [*RtcpPacket*](../modules.md#rtcppacket)[]

#### Parameters:

Name | Type |
:------ | :------ |
`data` | *Buffer* |

**Returns:** [*RtcpPacket*](../modules.md#rtcppacket)[]

Defined in: [rtp/src/rtcp/rtcp.ts:35](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/rtp/src/rtcp/rtcp.ts#L35)

___

### serialize

▸ `Static`**serialize**(`type`: *number*, `count`: *number*, `payload`: *Buffer*, `length`: *number*): *Buffer*

#### Parameters:

Name | Type |
:------ | :------ |
`type` | *number* |
`count` | *number* |
`payload` | *Buffer* |
`length` | *number* |

**Returns:** *Buffer*

Defined in: [rtp/src/rtcp/rtcp.ts:19](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/rtp/src/rtcp/rtcp.ts#L19)

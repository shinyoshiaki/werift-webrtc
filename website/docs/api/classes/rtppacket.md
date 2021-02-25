---
id: "rtppacket"
title: "Class: RtpPacket"
sidebar_label: "RtpPacket"
custom_edit_url: null
hide_title: true
---

# Class: RtpPacket

## Constructors

### constructor

\+ **new RtpPacket**(`header`: [*RtpHeader*](rtpheader.md), `payload`: *Buffer*): [*RtpPacket*](rtppacket.md)

#### Parameters:

Name | Type |
:------ | :------ |
`header` | [*RtpHeader*](rtpheader.md) |
`payload` | *Buffer* |

**Returns:** [*RtpPacket*](rtppacket.md)

Defined in: [rtp/src/rtp/rtp.ts:257](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/rtp/src/rtp/rtp.ts#L257)

## Properties

### header

• **header**: [*RtpHeader*](rtpheader.md)

___

### payload

• **payload**: *Buffer*

## Accessors

### serializeSize

• get **serializeSize**(): *number*

**Returns:** *number*

Defined in: [rtp/src/rtp/rtp.ts:260](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/rtp/src/rtp/rtp.ts#L260)

## Methods

### serialize

▸ **serialize**(): *Buffer*

**Returns:** *Buffer*

Defined in: [rtp/src/rtp/rtp.ts:264](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/rtp/src/rtp/rtp.ts#L264)

___

### deSerialize

▸ `Static`**deSerialize**(`buf`: *Buffer*): [*RtpPacket*](rtppacket.md)

#### Parameters:

Name | Type |
:------ | :------ |
`buf` | *Buffer* |

**Returns:** [*RtpPacket*](rtppacket.md)

Defined in: [rtp/src/rtp/rtp.ts:279](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/rtp/src/rtp/rtp.ts#L279)

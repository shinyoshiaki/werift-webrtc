---
id: "rtcptransportlayerfeedback"
title: "Class: RtcpTransportLayerFeedback"
sidebar_label: "RtcpTransportLayerFeedback"
custom_edit_url: null
hide_title: true
---

# Class: RtcpTransportLayerFeedback

## Constructors

### constructor

\+ **new RtcpTransportLayerFeedback**(`props?`: *Partial*<[*RtcpTransportLayerFeedback*](rtcptransportlayerfeedback.md)\>): [*RtcpTransportLayerFeedback*](rtcptransportlayerfeedback.md)

#### Parameters:

Name | Type |
:------ | :------ |
`props` | *Partial*<[*RtcpTransportLayerFeedback*](rtcptransportlayerfeedback.md)\> |

**Returns:** [*RtcpTransportLayerFeedback*](rtcptransportlayerfeedback.md)

Defined in: [rtp/src/rtcp/rtpfb/index.ts:11](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/rtp/src/rtcp/rtpfb/index.ts#L11)

## Properties

### feedback

• **feedback**: Feedback

Defined in: [rtp/src/rtcp/rtpfb/index.ts:10](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/rtp/src/rtcp/rtpfb/index.ts#L10)

___

### header

• **header**: [*RtcpHeader*](rtcpheader.md)

Defined in: [rtp/src/rtcp/rtpfb/index.ts:11](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/rtp/src/rtcp/rtpfb/index.ts#L11)

___

### type

• **type**: *number*

Defined in: [rtp/src/rtcp/rtpfb/index.ts:9](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/rtp/src/rtcp/rtpfb/index.ts#L9)

___

### type

▪ `Static` **type**: *number*= 205

Defined in: [rtp/src/rtcp/rtpfb/index.ts:8](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/rtp/src/rtcp/rtpfb/index.ts#L8)

## Methods

### serialize

▸ **serialize**(): *Buffer*

**Returns:** *Buffer*

Defined in: [rtp/src/rtcp/rtpfb/index.ts:17](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/rtp/src/rtcp/rtpfb/index.ts#L17)

___

### deSerialize

▸ `Static`**deSerialize**(`data`: *Buffer*, `header`: [*RtcpHeader*](rtcpheader.md)): [*RtcpTransportLayerFeedback*](rtcptransportlayerfeedback.md)

#### Parameters:

Name | Type |
:------ | :------ |
`data` | *Buffer* |
`header` | [*RtcpHeader*](rtcpheader.md) |

**Returns:** [*RtcpTransportLayerFeedback*](rtcptransportlayerfeedback.md)

Defined in: [rtp/src/rtcp/rtpfb/index.ts:22](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/rtp/src/rtcp/rtpfb/index.ts#L22)

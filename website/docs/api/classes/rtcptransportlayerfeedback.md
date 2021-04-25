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

Name | Type | Default value |
:------ | :------ | :------ |
`props` | *Partial*<[*RtcpTransportLayerFeedback*](rtcptransportlayerfeedback.md)\> | {} |

**Returns:** [*RtcpTransportLayerFeedback*](rtcptransportlayerfeedback.md)

Defined in: [rtp/src/rtcp/rtpfb/index.ts:14](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/rtp/src/rtcp/rtpfb/index.ts#L14)

## Properties

### feedback

• **feedback**: Feedback

Defined in: [rtp/src/rtcp/rtpfb/index.ts:13](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/rtp/src/rtcp/rtpfb/index.ts#L13)

___

### header

• **header**: [*RtcpHeader*](rtcpheader.md)

Defined in: [rtp/src/rtcp/rtpfb/index.ts:14](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/rtp/src/rtcp/rtpfb/index.ts#L14)

___

### type

• **type**: *number*

Defined in: [rtp/src/rtcp/rtpfb/index.ts:12](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/rtp/src/rtcp/rtpfb/index.ts#L12)

___

### type

▪ `Static` **type**: *number*= 205

Defined in: [rtp/src/rtcp/rtpfb/index.ts:11](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/rtp/src/rtcp/rtpfb/index.ts#L11)

## Methods

### serialize

▸ **serialize**(): *Buffer*

**Returns:** *Buffer*

Defined in: [rtp/src/rtcp/rtpfb/index.ts:20](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/rtp/src/rtcp/rtpfb/index.ts#L20)

___

### deSerialize

▸ `Static`**deSerialize**(`data`: *Buffer*, `header`: [*RtcpHeader*](rtcpheader.md)): [*RtcpTransportLayerFeedback*](rtcptransportlayerfeedback.md)

#### Parameters:

Name | Type |
:------ | :------ |
`data` | *Buffer* |
`header` | [*RtcpHeader*](rtcpheader.md) |

**Returns:** [*RtcpTransportLayerFeedback*](rtcptransportlayerfeedback.md)

Defined in: [rtp/src/rtcp/rtpfb/index.ts:25](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/rtp/src/rtcp/rtpfb/index.ts#L25)

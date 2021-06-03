---
id: "rtcptransportlayerfeedback"
title: "Class: RtcpTransportLayerFeedback"
sidebar_label: "RtcpTransportLayerFeedback"
sidebar_position: 0
custom_edit_url: null
---

## Constructors

### constructor

• **new RtcpTransportLayerFeedback**(`props?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`<[RtcpTransportLayerFeedback](rtcptransportlayerfeedback.md)\> |

#### Defined in

[packages/rtp/src/rtcp/rtpfb/index.ts:15](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/rtpfb/index.ts#L15)

## Properties

### feedback

• **feedback**: `Feedback`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/index.ts:14](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/rtpfb/index.ts#L14)

___

### header

• **header**: [RtcpHeader](rtcpheader.md)

#### Defined in

[packages/rtp/src/rtcp/rtpfb/index.ts:15](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/rtpfb/index.ts#L15)

___

### type

• **type**: `number`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/index.ts:13](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/rtpfb/index.ts#L13)

___

### type

▪ `Static` **type**: `number` = 205

#### Defined in

[packages/rtp/src/rtcp/rtpfb/index.ts:12](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/rtpfb/index.ts#L12)

## Methods

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/index.ts:21](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/rtpfb/index.ts#L21)

___

### deSerialize

▸ `Static` **deSerialize**(`data`, `header`): [RtcpTransportLayerFeedback](rtcptransportlayerfeedback.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |
| `header` | [RtcpHeader](rtcpheader.md) |

#### Returns

[RtcpTransportLayerFeedback](rtcptransportlayerfeedback.md)

#### Defined in

[packages/rtp/src/rtcp/rtpfb/index.ts:26](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/rtpfb/index.ts#L26)

---
id: "rtcppayloadspecificfeedback"
title: "Class: RtcpPayloadSpecificFeedback"
sidebar_label: "RtcpPayloadSpecificFeedback"
custom_edit_url: null
hide_title: true
---

# Class: RtcpPayloadSpecificFeedback

## Constructors

### constructor

\+ **new RtcpPayloadSpecificFeedback**(`props?`: *Partial*<[*RtcpPayloadSpecificFeedback*](rtcppayloadspecificfeedback.md)\>): [*RtcpPayloadSpecificFeedback*](rtcppayloadspecificfeedback.md)

#### Parameters:

Name | Type | Default value |
:------ | :------ | :------ |
`props` | *Partial*<[*RtcpPayloadSpecificFeedback*](rtcppayloadspecificfeedback.md)\> | {} |

**Returns:** [*RtcpPayloadSpecificFeedback*](rtcppayloadspecificfeedback.md)

Defined in: [rtp/src/rtcp/psfb/index.ts:19](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/rtp/src/rtcp/psfb/index.ts#L19)

## Properties

### feedback

• **feedback**: Feedback

Defined in: [rtp/src/rtcp/psfb/index.ts:19](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/rtp/src/rtcp/psfb/index.ts#L19)

___

### type

• **type**: *number*

Defined in: [rtp/src/rtcp/psfb/index.ts:17](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/rtp/src/rtcp/psfb/index.ts#L17)

___

### type

▪ `Static` **type**: *number*= 206

Defined in: [rtp/src/rtcp/psfb/index.ts:16](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/rtp/src/rtcp/psfb/index.ts#L16)

## Methods

### serialize

▸ **serialize**(): *Buffer*

**Returns:** *Buffer*

Defined in: [rtp/src/rtcp/psfb/index.ts:25](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/rtp/src/rtcp/psfb/index.ts#L25)

___

### deSerialize

▸ `Static`**deSerialize**(`data`: *Buffer*, `header`: [*RtcpHeader*](rtcpheader.md)): [*RtcpPayloadSpecificFeedback*](rtcppayloadspecificfeedback.md)

#### Parameters:

Name | Type |
:------ | :------ |
`data` | *Buffer* |
`header` | [*RtcpHeader*](rtcpheader.md) |

**Returns:** [*RtcpPayloadSpecificFeedback*](rtcppayloadspecificfeedback.md)

Defined in: [rtp/src/rtcp/psfb/index.ts:35](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/rtp/src/rtcp/psfb/index.ts#L35)

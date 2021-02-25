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

Name | Type |
:------ | :------ |
`props` | *Partial*<[*RtcpPayloadSpecificFeedback*](rtcppayloadspecificfeedback.md)\> |

**Returns:** [*RtcpPayloadSpecificFeedback*](rtcppayloadspecificfeedback.md)

Defined in: [rtp/src/rtcp/psfb/index.ts:16](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/rtp/src/rtcp/psfb/index.ts#L16)

## Properties

### feedback

• **feedback**: Feedback

Defined in: [rtp/src/rtcp/psfb/index.ts:16](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/rtp/src/rtcp/psfb/index.ts#L16)

___

### type

• **type**: *number*

Defined in: [rtp/src/rtcp/psfb/index.ts:14](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/rtp/src/rtcp/psfb/index.ts#L14)

___

### type

▪ `Static` **type**: *number*= 206

Defined in: [rtp/src/rtcp/psfb/index.ts:13](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/rtp/src/rtcp/psfb/index.ts#L13)

## Methods

### serialize

▸ **serialize**(): *Buffer*

**Returns:** *Buffer*

Defined in: [rtp/src/rtcp/psfb/index.ts:22](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/rtp/src/rtcp/psfb/index.ts#L22)

___

### deSerialize

▸ `Static`**deSerialize**(`data`: *Buffer*, `header`: [*RtcpHeader*](rtcpheader.md)): [*RtcpPayloadSpecificFeedback*](rtcppayloadspecificfeedback.md)

#### Parameters:

Name | Type |
:------ | :------ |
`data` | *Buffer* |
`header` | [*RtcpHeader*](rtcpheader.md) |

**Returns:** [*RtcpPayloadSpecificFeedback*](rtcppayloadspecificfeedback.md)

Defined in: [rtp/src/rtcp/psfb/index.ts:32](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/rtp/src/rtcp/psfb/index.ts#L32)

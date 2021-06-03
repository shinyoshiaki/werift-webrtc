---
id: "rtcppayloadspecificfeedback"
title: "Class: RtcpPayloadSpecificFeedback"
sidebar_label: "RtcpPayloadSpecificFeedback"
sidebar_position: 0
custom_edit_url: null
---

## Constructors

### constructor

• **new RtcpPayloadSpecificFeedback**(`props?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`<[RtcpPayloadSpecificFeedback](rtcppayloadspecificfeedback.md)\> |

#### Defined in

[packages/rtp/src/rtcp/psfb/index.ts:20](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/psfb/index.ts#L20)

## Properties

### feedback

• **feedback**: `Feedback`

#### Defined in

[packages/rtp/src/rtcp/psfb/index.ts:20](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/psfb/index.ts#L20)

___

### type

• **type**: `number`

#### Defined in

[packages/rtp/src/rtcp/psfb/index.ts:18](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/psfb/index.ts#L18)

___

### type

▪ `Static` **type**: `number` = 206

#### Defined in

[packages/rtp/src/rtcp/psfb/index.ts:17](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/psfb/index.ts#L17)

## Methods

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

#### Defined in

[packages/rtp/src/rtcp/psfb/index.ts:26](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/psfb/index.ts#L26)

___

### deSerialize

▸ `Static` **deSerialize**(`data`, `header`): [RtcpPayloadSpecificFeedback](rtcppayloadspecificfeedback.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |
| `header` | [RtcpHeader](rtcpheader.md) |

#### Returns

[RtcpPayloadSpecificFeedback](rtcppayloadspecificfeedback.md)

#### Defined in

[packages/rtp/src/rtcp/psfb/index.ts:36](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/psfb/index.ts#L36)

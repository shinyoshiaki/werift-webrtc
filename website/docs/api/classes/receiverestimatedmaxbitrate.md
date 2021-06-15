---
id: "receiverestimatedmaxbitrate"
title: "Class: ReceiverEstimatedMaxBitrate"
sidebar_label: "ReceiverEstimatedMaxBitrate"
sidebar_position: 0
custom_edit_url: null
---

## Constructors

### constructor

• **new ReceiverEstimatedMaxBitrate**(`props?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`<[ReceiverEstimatedMaxBitrate](receiverestimatedmaxbitrate.md)\> |

#### Defined in

[packages/rtp/src/rtcp/psfb/remb.ts:15](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtcp/psfb/remb.ts#L15)

## Properties

### bitrate

• **bitrate**: `bigint`

#### Defined in

[packages/rtp/src/rtcp/psfb/remb.ts:14](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtcp/psfb/remb.ts#L14)

___

### brExp

• **brExp**: `number`

#### Defined in

[packages/rtp/src/rtcp/psfb/remb.ts:12](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtcp/psfb/remb.ts#L12)

___

### brMantissa

• **brMantissa**: `number`

#### Defined in

[packages/rtp/src/rtcp/psfb/remb.ts:13](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtcp/psfb/remb.ts#L13)

___

### count

• **count**: `number`

#### Defined in

[packages/rtp/src/rtcp/psfb/remb.ts:7](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtcp/psfb/remb.ts#L7)

___

### length

• **length**: `number`

#### Defined in

[packages/rtp/src/rtcp/psfb/remb.ts:6](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtcp/psfb/remb.ts#L6)

___

### mediaSsrc

• **mediaSsrc**: `number`

#### Defined in

[packages/rtp/src/rtcp/psfb/remb.ts:9](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtcp/psfb/remb.ts#L9)

___

### senderSsrc

• **senderSsrc**: `number`

#### Defined in

[packages/rtp/src/rtcp/psfb/remb.ts:8](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtcp/psfb/remb.ts#L8)

___

### ssrcFeedbacks

• **ssrcFeedbacks**: `number`[] = []

#### Defined in

[packages/rtp/src/rtcp/psfb/remb.ts:15](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtcp/psfb/remb.ts#L15)

___

### ssrcNum

• **ssrcNum**: `number` = 0

#### Defined in

[packages/rtp/src/rtcp/psfb/remb.ts:11](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtcp/psfb/remb.ts#L11)

___

### uniqueID

• `Readonly` **uniqueID**: `string` = "REMB"

#### Defined in

[packages/rtp/src/rtcp/psfb/remb.ts:10](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtcp/psfb/remb.ts#L10)

___

### count

▪ `Static` **count**: `number` = 15

#### Defined in

[packages/rtp/src/rtcp/psfb/remb.ts:5](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtcp/psfb/remb.ts#L5)

## Methods

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

#### Defined in

[packages/rtp/src/rtcp/psfb/remb.ts:51](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtcp/psfb/remb.ts#L51)

___

### deSerialize

▸ `Static` **deSerialize**(`data`): [ReceiverEstimatedMaxBitrate](receiverestimatedmaxbitrate.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |

#### Returns

[ReceiverEstimatedMaxBitrate](receiverestimatedmaxbitrate.md)

#### Defined in

[packages/rtp/src/rtcp/psfb/remb.ts:21](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtcp/psfb/remb.ts#L21)

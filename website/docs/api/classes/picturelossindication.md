---
id: "picturelossindication"
title: "Class: PictureLossIndication"
sidebar_label: "PictureLossIndication"
sidebar_position: 0
custom_edit_url: null
---

## Constructors

### constructor

• **new PictureLossIndication**(`props?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`<[PictureLossIndication](picturelossindication.md)\> |

#### Defined in

[packages/rtp/src/rtcp/psfb/pictureLossIndication.ts:9](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtcp/psfb/pictureLossIndication.ts#L9)

## Properties

### count

• **count**: `number`

#### Defined in

[packages/rtp/src/rtcp/psfb/pictureLossIndication.ts:5](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtcp/psfb/pictureLossIndication.ts#L5)

___

### length

• **length**: `number` = 2

#### Defined in

[packages/rtp/src/rtcp/psfb/pictureLossIndication.ts:6](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtcp/psfb/pictureLossIndication.ts#L6)

___

### mediaSsrc

• **mediaSsrc**: `number`

#### Defined in

[packages/rtp/src/rtcp/psfb/pictureLossIndication.ts:9](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtcp/psfb/pictureLossIndication.ts#L9)

___

### senderSsrc

• **senderSsrc**: `number`

#### Defined in

[packages/rtp/src/rtcp/psfb/pictureLossIndication.ts:8](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtcp/psfb/pictureLossIndication.ts#L8)

___

### count

▪ `Static` **count**: `number` = 1

#### Defined in

[packages/rtp/src/rtcp/psfb/pictureLossIndication.ts:4](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtcp/psfb/pictureLossIndication.ts#L4)

## Methods

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

#### Defined in

[packages/rtp/src/rtcp/psfb/pictureLossIndication.ts:20](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtcp/psfb/pictureLossIndication.ts#L20)

___

### deSerialize

▸ `Static` **deSerialize**(`data`): [PictureLossIndication](picturelossindication.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |

#### Returns

[PictureLossIndication](picturelossindication.md)

#### Defined in

[packages/rtp/src/rtcp/psfb/pictureLossIndication.ts:15](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtcp/psfb/pictureLossIndication.ts#L15)

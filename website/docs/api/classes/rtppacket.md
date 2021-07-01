---
id: "rtppacket"
title: "Class: RtpPacket"
sidebar_label: "RtpPacket"
sidebar_position: 0
custom_edit_url: null
---

## Constructors

### constructor

• **new RtpPacket**(`header`, `payload`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `header` | [RtpHeader](rtpheader.md) |
| `payload` | `Buffer` |

#### Defined in

[packages/rtp/src/rtp/rtp.ts:266](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/rtp/rtp.ts#L266)

## Properties

### header

• **header**: [RtpHeader](rtpheader.md)

___

### payload

• **payload**: `Buffer`

## Accessors

### serializeSize

• `get` **serializeSize**(): `number`

#### Returns

`number`

#### Defined in

[packages/rtp/src/rtp/rtp.ts:269](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/rtp/rtp.ts#L269)

## Methods

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

#### Defined in

[packages/rtp/src/rtp/rtp.ts:273](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/rtp/rtp.ts#L273)

___

### deSerialize

▸ `Static` **deSerialize**(`buf`): [RtpPacket](rtppacket.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `buf` | `Buffer` |

#### Returns

[RtpPacket](rtppacket.md)

#### Defined in

[packages/rtp/src/rtp/rtp.ts:288](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/rtp/rtp.ts#L288)

---
id: "rtcpheader"
title: "Class: RtcpHeader"
sidebar_label: "RtcpHeader"
sidebar_position: 0
custom_edit_url: null
---

## Constructors

### constructor

• **new RtcpHeader**(`props?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`<[RtcpHeader](rtcpheader.md)\> |

#### Defined in

[packages/rtp/src/rtcp/header.ts:19](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/rtcp/header.ts#L19)

## Properties

### count

• **count**: `number` = 0

#### Defined in

[packages/rtp/src/rtcp/header.ts:17](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/rtcp/header.ts#L17)

___

### length

• **length**: `number` = 0

#### Defined in

[packages/rtp/src/rtcp/header.ts:19](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/rtcp/header.ts#L19)

___

### padding

• **padding**: `boolean` = false

#### Defined in

[packages/rtp/src/rtcp/header.ts:16](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/rtcp/header.ts#L16)

___

### type

• **type**: `number` = 0

#### Defined in

[packages/rtp/src/rtcp/header.ts:18](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/rtcp/header.ts#L18)

___

### version

• **version**: `number` = 2

#### Defined in

[packages/rtp/src/rtcp/header.ts:15](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/rtcp/header.ts#L15)

## Methods

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

#### Defined in

[packages/rtp/src/rtcp/header.ts:25](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/rtcp/header.ts#L25)

___

### deSerialize

▸ `Static` **deSerialize**(`buf`): [RtcpHeader](rtcpheader.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `buf` | `Buffer` |

#### Returns

[RtcpHeader](rtcpheader.md)

#### Defined in

[packages/rtp/src/rtcp/header.ts:34](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/rtcp/header.ts#L34)

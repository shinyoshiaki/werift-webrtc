---
id: "rtcpsrpacket"
title: "Class: RtcpSrPacket"
sidebar_label: "RtcpSrPacket"
sidebar_position: 0
custom_edit_url: null
---

## Constructors

### constructor

• **new RtcpSrPacket**(`props?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`<[RtcpSrPacket](rtcpsrpacket.md)\> |

#### Defined in

[packages/rtp/src/rtcp/sr.ts:12](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/sr.ts#L12)

## Properties

### reports

• **reports**: [RtcpReceiverInfo](rtcpreceiverinfo.md)[] = []

#### Defined in

[packages/rtp/src/rtcp/sr.ts:10](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/sr.ts#L10)

___

### senderInfo

• **senderInfo**: [RtcpSenderInfo](rtcpsenderinfo.md)

#### Defined in

[packages/rtp/src/rtcp/sr.ts:9](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/sr.ts#L9)

___

### ssrc

• **ssrc**: `number` = 0

#### Defined in

[packages/rtp/src/rtcp/sr.ts:8](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/sr.ts#L8)

___

### type

• **type**: `number`

#### Defined in

[packages/rtp/src/rtcp/sr.ts:12](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/sr.ts#L12)

___

### type

▪ `Static` **type**: `number` = 200

#### Defined in

[packages/rtp/src/rtcp/sr.ts:11](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/sr.ts#L11)

## Methods

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

#### Defined in

[packages/rtp/src/rtcp/sr.ts:18](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/sr.ts#L18)

___

### deSerialize

▸ `Static` **deSerialize**(`payload`, `count`): [RtcpSrPacket](rtcpsrpacket.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `payload` | `Buffer` |
| `count` | `number` |

#### Returns

[RtcpSrPacket](rtcpsrpacket.md)

#### Defined in

[packages/rtp/src/rtcp/sr.ts:34](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/sr.ts#L34)

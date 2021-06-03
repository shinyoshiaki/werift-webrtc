---
id: "rtcppacketconverter"
title: "Class: RtcpPacketConverter"
sidebar_label: "RtcpPacketConverter"
sidebar_position: 0
custom_edit_url: null
---

## Constructors

### constructor

• **new RtcpPacketConverter**()

## Methods

### deSerialize

▸ `Static` **deSerialize**(`data`): [RtcpPacket](../modules.md#rtcppacket)[]

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |

#### Returns

[RtcpPacket](../modules.md#rtcppacket)[]

#### Defined in

[packages/rtp/src/rtcp/rtcp.ts:36](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/rtcp.ts#L36)

___

### serialize

▸ `Static` **serialize**(`type`, `count`, `payload`, `length`): `Buffer`

#### Parameters

| Name | Type |
| :------ | :------ |
| `type` | `number` |
| `count` | `number` |
| `payload` | `Buffer` |
| `length` | `number` |

#### Returns

`Buffer`

#### Defined in

[packages/rtp/src/rtcp/rtcp.ts:20](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/rtcp.ts#L20)

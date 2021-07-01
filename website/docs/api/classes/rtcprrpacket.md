---
id: "rtcprrpacket"
title: "Class: RtcpRrPacket"
sidebar_label: "RtcpRrPacket"
sidebar_position: 0
custom_edit_url: null
---

## Constructors

### constructor

• **new RtcpRrPacket**(`props?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`<[RtcpRrPacket](rtcprrpacket.md)\> |

#### Defined in

[packages/rtp/src/rtcp/rr.ts:10](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/rtcp/rr.ts#L10)

## Properties

### reports

• **reports**: [RtcpReceiverInfo](rtcpreceiverinfo.md)[] = []

#### Defined in

[packages/rtp/src/rtcp/rr.ts:8](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/rtcp/rr.ts#L8)

___

### ssrc

• **ssrc**: `number` = 0

#### Defined in

[packages/rtp/src/rtcp/rr.ts:7](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/rtcp/rr.ts#L7)

___

### type

• **type**: `number`

#### Defined in

[packages/rtp/src/rtcp/rr.ts:10](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/rtcp/rr.ts#L10)

___

### type

▪ `Static` **type**: `number` = 201

#### Defined in

[packages/rtp/src/rtcp/rr.ts:9](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/rtcp/rr.ts#L9)

## Methods

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

#### Defined in

[packages/rtp/src/rtcp/rr.ts:16](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/rtcp/rr.ts#L16)

___

### deSerialize

▸ `Static` **deSerialize**(`data`, `count`): [RtcpRrPacket](rtcprrpacket.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |
| `count` | `number` |

#### Returns

[RtcpRrPacket](rtcprrpacket.md)

#### Defined in

[packages/rtp/src/rtcp/rr.ts:30](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/rtcp/rr.ts#L30)

---
id: "rtcpsourcedescriptionpacket"
title: "Class: RtcpSourceDescriptionPacket"
sidebar_label: "RtcpSourceDescriptionPacket"
sidebar_position: 0
custom_edit_url: null
---

## Constructors

### constructor

• **new RtcpSourceDescriptionPacket**(`props`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`<[RtcpSourceDescriptionPacket](rtcpsourcedescriptionpacket.md)\> |

#### Defined in

[packages/rtp/src/rtcp/sdes.ts:8](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/sdes.ts#L8)

## Properties

### chunks

• **chunks**: [SourceDescriptionChunk](sourcedescriptionchunk.md)[] = []

#### Defined in

[packages/rtp/src/rtcp/sdes.ts:8](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/sdes.ts#L8)

___

### type

• **type**: `number`

#### Defined in

[packages/rtp/src/rtcp/sdes.ts:7](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/sdes.ts#L7)

___

### type

▪ `Static` **type**: `number` = 202

#### Defined in

[packages/rtp/src/rtcp/sdes.ts:6](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/sdes.ts#L6)

## Accessors

### length

• `get` **length**(): `number`

#### Returns

`number`

#### Defined in

[packages/rtp/src/rtcp/sdes.ts:14](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/sdes.ts#L14)

## Methods

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

#### Defined in

[packages/rtp/src/rtcp/sdes.ts:20](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/sdes.ts#L20)

___

### deSerialize

▸ `Static` **deSerialize**(`payload`, `header`): [RtcpSourceDescriptionPacket](rtcpsourcedescriptionpacket.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `payload` | `Buffer` |
| `header` | [RtcpHeader](rtcpheader.md) |

#### Returns

[RtcpSourceDescriptionPacket](rtcpsourcedescriptionpacket.md)

#### Defined in

[packages/rtp/src/rtcp/sdes.ts:32](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/sdes.ts#L32)

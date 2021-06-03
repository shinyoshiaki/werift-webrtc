---
id: "rtcpsenderinfo"
title: "Class: RtcpSenderInfo"
sidebar_label: "RtcpSenderInfo"
sidebar_position: 0
custom_edit_url: null
---

## Constructors

### constructor

• **new RtcpSenderInfo**(`props?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`<[RtcpSenderInfo](rtcpsenderinfo.md)\> |

#### Defined in

[packages/rtp/src/rtcp/sr.ts:51](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/sr.ts#L51)

## Properties

### ntpTimestamp

• **ntpTimestamp**: `bigint`

#### Defined in

[packages/rtp/src/rtcp/sr.ts:48](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/sr.ts#L48)

___

### octetCount

• **octetCount**: `number`

#### Defined in

[packages/rtp/src/rtcp/sr.ts:51](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/sr.ts#L51)

___

### packetCount

• **packetCount**: `number`

#### Defined in

[packages/rtp/src/rtcp/sr.ts:50](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/sr.ts#L50)

___

### rtpTimestamp

• **rtpTimestamp**: `number`

#### Defined in

[packages/rtp/src/rtcp/sr.ts:49](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/sr.ts#L49)

## Methods

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

#### Defined in

[packages/rtp/src/rtcp/sr.ts:57](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/sr.ts#L57)

___

### deSerialize

▸ `Static` **deSerialize**(`data`): [RtcpSenderInfo](rtcpsenderinfo.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |

#### Returns

[RtcpSenderInfo](rtcpsenderinfo.md)

#### Defined in

[packages/rtp/src/rtcp/sr.ts:64](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/sr.ts#L64)

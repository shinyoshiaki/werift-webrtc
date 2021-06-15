---
id: "rtcpreceiverinfo"
title: "Class: RtcpReceiverInfo"
sidebar_label: "RtcpReceiverInfo"
sidebar_position: 0
custom_edit_url: null
---

## Constructors

### constructor

• **new RtcpReceiverInfo**(`props?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`<[RtcpReceiverInfo](rtcpreceiverinfo.md)\> |

#### Defined in

[packages/rtp/src/rtcp/rr.ts:49](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtcp/rr.ts#L49)

## Properties

### dlsr

• **dlsr**: `number`

#### Defined in

[packages/rtp/src/rtcp/rr.ts:49](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtcp/rr.ts#L49)

___

### fractionLost

• **fractionLost**: `number`

#### Defined in

[packages/rtp/src/rtcp/rr.ts:44](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtcp/rr.ts#L44)

___

### highestSequence

• **highestSequence**: `number`

#### Defined in

[packages/rtp/src/rtcp/rr.ts:46](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtcp/rr.ts#L46)

___

### jitter

• **jitter**: `number`

#### Defined in

[packages/rtp/src/rtcp/rr.ts:47](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtcp/rr.ts#L47)

___

### lsr

• **lsr**: `number`

#### Defined in

[packages/rtp/src/rtcp/rr.ts:48](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtcp/rr.ts#L48)

___

### packetsLost

• **packetsLost**: `number`

#### Defined in

[packages/rtp/src/rtcp/rr.ts:45](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtcp/rr.ts#L45)

___

### ssrc

• **ssrc**: `number`

#### Defined in

[packages/rtp/src/rtcp/rr.ts:43](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtcp/rr.ts#L43)

## Methods

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

#### Defined in

[packages/rtp/src/rtcp/rr.ts:55](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtcp/rr.ts#L55)

___

### deSerialize

▸ `Static` **deSerialize**(`data`): [RtcpReceiverInfo](rtcpreceiverinfo.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |

#### Returns

[RtcpReceiverInfo](rtcpreceiverinfo.md)

#### Defined in

[packages/rtp/src/rtcp/rr.ts:70](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtcp/rr.ts#L70)

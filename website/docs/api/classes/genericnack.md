---
id: "genericnack"
title: "Class: GenericNack"
sidebar_label: "GenericNack"
sidebar_position: 0
custom_edit_url: null
---

## Constructors

### constructor

• **new GenericNack**(`props?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`<[GenericNack](genericnack.md)\> |

#### Defined in

[packages/rtp/src/rtcp/rtpfb/nack.ts:12](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/rtpfb/nack.ts#L12)

## Properties

### count

• `Readonly` **count**: `number`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/nack.ts:8](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/rtpfb/nack.ts#L8)

___

### header

• **header**: [RtcpHeader](rtcpheader.md)

#### Defined in

[packages/rtp/src/rtcp/rtpfb/nack.ts:9](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/rtpfb/nack.ts#L9)

___

### lost

• **lost**: `number`[] = []

#### Defined in

[packages/rtp/src/rtcp/rtpfb/nack.ts:12](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/rtpfb/nack.ts#L12)

___

### mediaSourceSsrc

• **mediaSourceSsrc**: `number`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/nack.ts:11](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/rtpfb/nack.ts#L11)

___

### senderSsrc

• **senderSsrc**: `number`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/nack.ts:10](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/rtpfb/nack.ts#L10)

___

### count

▪ `Static` **count**: `number` = 1

#### Defined in

[packages/rtp/src/rtcp/rtpfb/nack.ts:7](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/rtpfb/nack.ts#L7)

## Methods

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/nack.ts:49](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/rtpfb/nack.ts#L49)

___

### deSerialize

▸ `Static` **deSerialize**(`data`, `header`): [GenericNack](genericnack.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |
| `header` | [RtcpHeader](rtcpheader.md) |

#### Returns

[GenericNack](genericnack.md)

#### Defined in

[packages/rtp/src/rtcp/rtpfb/nack.ts:25](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/rtpfb/nack.ts#L25)

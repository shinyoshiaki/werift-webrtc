---
id: "recvdelta"
title: "Class: RecvDelta"
sidebar_label: "RecvDelta"
sidebar_position: 0
custom_edit_url: null
---

## Constructors

### constructor

• **new RecvDelta**(`props?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`<[RecvDelta](recvdelta.md)\> |

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:355](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtcp/rtpfb/twcc.ts#L355)

## Properties

### delta

• **delta**: `number`

micro sec

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:355](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtcp/rtpfb/twcc.ts#L355)

___

### parsed

• **parsed**: `boolean` = false

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:383](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtcp/rtpfb/twcc.ts#L383)

___

### type

• `Optional` **type**: [TypeTCCPacketReceivedSmallDelta](../enums/packetstatus.md#typetccpacketreceivedsmalldelta) \| [TypeTCCPacketReceivedLargeDelta](../enums/packetstatus.md#typetccpacketreceivedlargedelta)

optional (If undefined, it will be set automatically.)

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:351](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtcp/rtpfb/twcc.ts#L351)

## Methods

### deSerialize

▸ **deSerialize**(`data`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |

#### Returns

`void`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:378](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtcp/rtpfb/twcc.ts#L378)

___

### parseDelta

▸ **parseDelta**(): `void`

#### Returns

`void`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:384](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtcp/rtpfb/twcc.ts#L384)

___

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:397](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtcp/rtpfb/twcc.ts#L397)

___

### deSerialize

▸ `Static` **deSerialize**(`data`): [RecvDelta](recvdelta.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |

#### Returns

[RecvDelta](recvdelta.md)

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:361](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtcp/rtpfb/twcc.ts#L361)

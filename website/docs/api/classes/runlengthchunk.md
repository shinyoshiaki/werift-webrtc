---
id: "runlengthchunk"
title: "Class: RunLengthChunk"
sidebar_label: "RunLengthChunk"
sidebar_position: 0
custom_edit_url: null
---

## Constructors

### constructor

• **new RunLengthChunk**(`props?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`<[RunLengthChunk](runlengthchunk.md)\> |

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:256](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/rtcp/rtpfb/twcc.ts#L256)

## Properties

### packetStatus

• **packetStatus**: [PacketStatus](../enums/packetstatus.md)

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:254](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/rtcp/rtpfb/twcc.ts#L254)

___

### runLength

• **runLength**: `number`

13bit

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:256](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/rtcp/rtpfb/twcc.ts#L256)

___

### type

• **type**: [TypeTCCRunLengthChunk](../enums/packetchunk.md#typetccrunlengthchunk)

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:253](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/rtcp/rtpfb/twcc.ts#L253)

## Methods

### results

▸ **results**(`currentSequenceNumber`): `PacketResult`[]

#### Parameters

| Name | Type |
| :------ | :------ |
| `currentSequenceNumber` | `number` |

#### Returns

`PacketResult`[]

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:282](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/rtcp/rtpfb/twcc.ts#L282)

___

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:270](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/rtcp/rtpfb/twcc.ts#L270)

___

### deSerialize

▸ `Static` **deSerialize**(`data`): [RunLengthChunk](runlengthchunk.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |

#### Returns

[RunLengthChunk](runlengthchunk.md)

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:263](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/rtcp/rtpfb/twcc.ts#L263)

---
id: "statusvectorchunk"
title: "Class: StatusVectorChunk"
sidebar_label: "StatusVectorChunk"
sidebar_position: 0
custom_edit_url: null
---

## Constructors

### constructor

• **new StatusVectorChunk**(`props?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`<[StatusVectorChunk](statusvectorchunk.md)\> |

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:304](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtcp/rtpfb/twcc.ts#L304)

## Properties

### symbolList

• **symbolList**: `number`[] = []

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:304](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtcp/rtpfb/twcc.ts#L304)

___

### symbolSize

• **symbolSize**: `number`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:303](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtcp/rtpfb/twcc.ts#L303)

___

### type

• **type**: `number`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:302](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtcp/rtpfb/twcc.ts#L302)

## Methods

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:331](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtcp/rtpfb/twcc.ts#L331)

___

### deSerialize

▸ `Static` **deSerialize**(`data`): [StatusVectorChunk](statusvectorchunk.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |

#### Returns

[StatusVectorChunk](statusvectorchunk.md)

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:310](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtcp/rtpfb/twcc.ts#L310)

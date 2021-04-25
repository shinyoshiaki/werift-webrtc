---
id: "statusvectorchunk"
title: "Class: StatusVectorChunk"
sidebar_label: "StatusVectorChunk"
custom_edit_url: null
hide_title: true
---

# Class: StatusVectorChunk

## Constructors

### constructor

\+ **new StatusVectorChunk**(`props?`: *Partial*<[*StatusVectorChunk*](statusvectorchunk.md)\>): [*StatusVectorChunk*](statusvectorchunk.md)

#### Parameters:

Name | Type | Default value |
:------ | :------ | :------ |
`props` | *Partial*<[*StatusVectorChunk*](statusvectorchunk.md)\> | {} |

**Returns:** [*StatusVectorChunk*](statusvectorchunk.md)

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:303](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/rtp/src/rtcp/rtpfb/twcc.ts#L303)

## Properties

### symbolList

• **symbolList**: *number*[]= []

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:303](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/rtp/src/rtcp/rtpfb/twcc.ts#L303)

___

### symbolSize

• **symbolSize**: *number*

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:302](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/rtp/src/rtcp/rtpfb/twcc.ts#L302)

___

### type

• **type**: *number*

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:301](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/rtp/src/rtcp/rtpfb/twcc.ts#L301)

## Methods

### serialize

▸ **serialize**(): *Buffer*

**Returns:** *Buffer*

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:330](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/rtp/src/rtcp/rtpfb/twcc.ts#L330)

___

### deSerialize

▸ `Static`**deSerialize**(`data`: *Buffer*): [*StatusVectorChunk*](statusvectorchunk.md)

#### Parameters:

Name | Type |
:------ | :------ |
`data` | *Buffer* |

**Returns:** [*StatusVectorChunk*](statusvectorchunk.md)

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:309](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/rtp/src/rtcp/rtpfb/twcc.ts#L309)

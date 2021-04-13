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

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:300](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/rtp/src/rtcp/rtpfb/twcc.ts#L300)

## Properties

### symbolList

• **symbolList**: *number*[]= []

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:300](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/rtp/src/rtcp/rtpfb/twcc.ts#L300)

___

### symbolSize

• **symbolSize**: *number*

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:299](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/rtp/src/rtcp/rtpfb/twcc.ts#L299)

___

### type

• **type**: *number*

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:298](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/rtp/src/rtcp/rtpfb/twcc.ts#L298)

## Methods

### serialize

▸ **serialize**(): *Buffer*

**Returns:** *Buffer*

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:327](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/rtp/src/rtcp/rtpfb/twcc.ts#L327)

___

### deSerialize

▸ `Static`**deSerialize**(`data`: *Buffer*): [*StatusVectorChunk*](statusvectorchunk.md)

#### Parameters:

Name | Type |
:------ | :------ |
`data` | *Buffer* |

**Returns:** [*StatusVectorChunk*](statusvectorchunk.md)

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:306](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/rtp/src/rtcp/rtpfb/twcc.ts#L306)

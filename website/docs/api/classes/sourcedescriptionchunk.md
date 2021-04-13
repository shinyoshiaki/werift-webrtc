---
id: "sourcedescriptionchunk"
title: "Class: SourceDescriptionChunk"
sidebar_label: "SourceDescriptionChunk"
custom_edit_url: null
hide_title: true
---

# Class: SourceDescriptionChunk

## Constructors

### constructor

\+ **new SourceDescriptionChunk**(`props?`: *Partial*<[*SourceDescriptionChunk*](sourcedescriptionchunk.md)\>): [*SourceDescriptionChunk*](sourcedescriptionchunk.md)

#### Parameters:

Name | Type | Default value |
:------ | :------ | :------ |
`props` | *Partial*<[*SourceDescriptionChunk*](sourcedescriptionchunk.md)\> | {} |

**Returns:** [*SourceDescriptionChunk*](sourcedescriptionchunk.md)

Defined in: [rtp/src/rtcp/sdes.ts:46](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/rtp/src/rtcp/sdes.ts#L46)

## Properties

### items

• **items**: [*SourceDescriptionItem*](sourcedescriptionitem.md)[]= []

Defined in: [rtp/src/rtcp/sdes.ts:46](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/rtp/src/rtcp/sdes.ts#L46)

___

### source

• **source**: *number*

Defined in: [rtp/src/rtcp/sdes.ts:45](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/rtp/src/rtcp/sdes.ts#L45)

## Accessors

### length

• get **length**(): *number*

**Returns:** *number*

Defined in: [rtp/src/rtcp/sdes.ts:52](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/rtp/src/rtcp/sdes.ts#L52)

## Methods

### serialize

▸ **serialize**(): *Buffer*

**Returns:** *Buffer*

Defined in: [rtp/src/rtcp/sdes.ts:60](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/rtp/src/rtcp/sdes.ts#L60)

___

### deSerialize

▸ `Static`**deSerialize**(`data`: *Buffer*): [*SourceDescriptionChunk*](sourcedescriptionchunk.md)

#### Parameters:

Name | Type |
:------ | :------ |
`data` | *Buffer* |

**Returns:** [*SourceDescriptionChunk*](sourcedescriptionchunk.md)

Defined in: [rtp/src/rtcp/sdes.ts:70](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/rtp/src/rtcp/sdes.ts#L70)

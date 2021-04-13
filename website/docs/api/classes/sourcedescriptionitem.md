---
id: "sourcedescriptionitem"
title: "Class: SourceDescriptionItem"
sidebar_label: "SourceDescriptionItem"
custom_edit_url: null
hide_title: true
---

# Class: SourceDescriptionItem

## Constructors

### constructor

\+ **new SourceDescriptionItem**(`props`: *Partial*<[*SourceDescriptionItem*](sourcedescriptionitem.md)\>): [*SourceDescriptionItem*](sourcedescriptionitem.md)

#### Parameters:

Name | Type |
:------ | :------ |
`props` | *Partial*<[*SourceDescriptionItem*](sourcedescriptionitem.md)\> |

**Returns:** [*SourceDescriptionItem*](sourcedescriptionitem.md)

Defined in: [rtp/src/rtcp/sdes.ts:88](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/rtp/src/rtcp/sdes.ts#L88)

## Properties

### text

• **text**: *string*

Defined in: [rtp/src/rtcp/sdes.ts:88](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/rtp/src/rtcp/sdes.ts#L88)

___

### type

• **type**: *number*

Defined in: [rtp/src/rtcp/sdes.ts:87](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/rtp/src/rtcp/sdes.ts#L87)

## Accessors

### length

• get **length**(): *number*

**Returns:** *number*

Defined in: [rtp/src/rtcp/sdes.ts:94](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/rtp/src/rtcp/sdes.ts#L94)

## Methods

### serialize

▸ **serialize**(): *Buffer*

**Returns:** *Buffer*

Defined in: [rtp/src/rtcp/sdes.ts:98](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/rtp/src/rtcp/sdes.ts#L98)

___

### deSerialize

▸ `Static`**deSerialize**(`data`: *Buffer*): [*SourceDescriptionItem*](sourcedescriptionitem.md)

#### Parameters:

Name | Type |
:------ | :------ |
`data` | *Buffer* |

**Returns:** [*SourceDescriptionItem*](sourcedescriptionitem.md)

Defined in: [rtp/src/rtcp/sdes.ts:106](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/rtp/src/rtcp/sdes.ts#L106)

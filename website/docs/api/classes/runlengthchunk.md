---
id: "runlengthchunk"
title: "Class: RunLengthChunk"
sidebar_label: "RunLengthChunk"
custom_edit_url: null
hide_title: true
---

# Class: RunLengthChunk

## Constructors

### constructor

\+ **new RunLengthChunk**(`props?`: *Partial*<[*RunLengthChunk*](runlengthchunk.md)\>): [*RunLengthChunk*](runlengthchunk.md)

#### Parameters:

Name | Type | Default value |
:------ | :------ | :------ |
`props` | *Partial*<[*RunLengthChunk*](runlengthchunk.md)\> | {} |

**Returns:** [*RunLengthChunk*](runlengthchunk.md)

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:255](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/rtp/src/rtcp/rtpfb/twcc.ts#L255)

## Properties

### packetStatus

• **packetStatus**: [*PacketStatus*](../enums/packetstatus.md)

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:253](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/rtp/src/rtcp/rtpfb/twcc.ts#L253)

___

### runLength

• **runLength**: *number*

13bit

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:255](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/rtp/src/rtcp/rtpfb/twcc.ts#L255)

___

### type

• **type**: [*TypeTCCRunLengthChunk*](../enums/packetchunk.md#typetccrunlengthchunk)

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:252](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/rtp/src/rtcp/rtpfb/twcc.ts#L252)

## Methods

### results

▸ **results**(`currentSequenceNumber`: *number*): *PacketResult*[]

#### Parameters:

Name | Type |
:------ | :------ |
`currentSequenceNumber` | *number* |

**Returns:** *PacketResult*[]

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:281](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/rtp/src/rtcp/rtpfb/twcc.ts#L281)

___

### serialize

▸ **serialize**(): *Buffer*

**Returns:** *Buffer*

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:269](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/rtp/src/rtcp/rtpfb/twcc.ts#L269)

___

### deSerialize

▸ `Static`**deSerialize**(`data`: *Buffer*): [*RunLengthChunk*](runlengthchunk.md)

#### Parameters:

Name | Type |
:------ | :------ |
`data` | *Buffer* |

**Returns:** [*RunLengthChunk*](runlengthchunk.md)

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:262](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/rtp/src/rtcp/rtpfb/twcc.ts#L262)

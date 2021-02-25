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

Name | Type |
:------ | :------ |
`props` | *Partial*<[*RunLengthChunk*](runlengthchunk.md)\> |

**Returns:** [*RunLengthChunk*](runlengthchunk.md)

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:252](https://github.com/shinyoshiaki/werift-webrtc/blob/b7c7a6e/packages/rtp/src/rtcp/rtpfb/twcc.ts#L252)

## Properties

### packetStatus

• **packetStatus**: [*PacketStatus*](../enums/packetstatus.md)

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:250](https://github.com/shinyoshiaki/werift-webrtc/blob/b7c7a6e/packages/rtp/src/rtcp/rtpfb/twcc.ts#L250)

___

### runLength

• **runLength**: *number*

13bit

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:252](https://github.com/shinyoshiaki/werift-webrtc/blob/b7c7a6e/packages/rtp/src/rtcp/rtpfb/twcc.ts#L252)

___

### type

• **type**: [*TypeTCCRunLengthChunk*](../enums/packetchunk.md#typetccrunlengthchunk)

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:249](https://github.com/shinyoshiaki/werift-webrtc/blob/b7c7a6e/packages/rtp/src/rtcp/rtpfb/twcc.ts#L249)

## Methods

### results

▸ **results**(`currentSequenceNumber`: *number*): *PacketResult*[]

#### Parameters:

Name | Type |
:------ | :------ |
`currentSequenceNumber` | *number* |

**Returns:** *PacketResult*[]

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:278](https://github.com/shinyoshiaki/werift-webrtc/blob/b7c7a6e/packages/rtp/src/rtcp/rtpfb/twcc.ts#L278)

___

### serialize

▸ **serialize**(): *Buffer*

**Returns:** *Buffer*

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:266](https://github.com/shinyoshiaki/werift-webrtc/blob/b7c7a6e/packages/rtp/src/rtcp/rtpfb/twcc.ts#L266)

___

### deSerialize

▸ `Static`**deSerialize**(`data`: *Buffer*): [*RunLengthChunk*](runlengthchunk.md)

#### Parameters:

Name | Type |
:------ | :------ |
`data` | *Buffer* |

**Returns:** [*RunLengthChunk*](runlengthchunk.md)

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:259](https://github.com/shinyoshiaki/werift-webrtc/blob/b7c7a6e/packages/rtp/src/rtcp/rtpfb/twcc.ts#L259)

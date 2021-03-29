---
id: "recvdelta"
title: "Class: RecvDelta"
sidebar_label: "RecvDelta"
custom_edit_url: null
hide_title: true
---

# Class: RecvDelta

## Constructors

### constructor

\+ **new RecvDelta**(`props?`: *Partial*<[*RecvDelta*](recvdelta.md)\>): [*RecvDelta*](recvdelta.md)

#### Parameters:

Name | Type |
:------ | :------ |
`props` | *Partial*<[*RecvDelta*](recvdelta.md)\> |

**Returns:** [*RecvDelta*](recvdelta.md)

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:351](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/rtp/src/rtcp/rtpfb/twcc.ts#L351)

## Properties

### delta

• **delta**: *number*

micro sec

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:351](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/rtp/src/rtcp/rtpfb/twcc.ts#L351)

___

### parsed

• **parsed**: *boolean*= false

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:379](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/rtp/src/rtcp/rtpfb/twcc.ts#L379)

___

### type

• `Optional` **type**: [*TypeTCCPacketReceivedSmallDelta*](../enums/packetstatus.md#typetccpacketreceivedsmalldelta) \| [*TypeTCCPacketReceivedLargeDelta*](../enums/packetstatus.md#typetccpacketreceivedlargedelta)

optional (If undefined, it will be set automatically.)

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:347](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/rtp/src/rtcp/rtpfb/twcc.ts#L347)

## Methods

### deSerialize

▸ **deSerialize**(`data`: *Buffer*): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`data` | *Buffer* |

**Returns:** *void*

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:374](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/rtp/src/rtcp/rtpfb/twcc.ts#L374)

___

### parseDelta

▸ **parseDelta**(): *void*

**Returns:** *void*

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:380](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/rtp/src/rtcp/rtpfb/twcc.ts#L380)

___

### serialize

▸ **serialize**(): *Buffer*

**Returns:** *Buffer*

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:393](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/rtp/src/rtcp/rtpfb/twcc.ts#L393)

___

### deSerialize

▸ `Static`**deSerialize**(`data`: *Buffer*): [*RecvDelta*](recvdelta.md)

#### Parameters:

Name | Type |
:------ | :------ |
`data` | *Buffer* |

**Returns:** [*RecvDelta*](recvdelta.md)

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:357](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/rtp/src/rtcp/rtpfb/twcc.ts#L357)

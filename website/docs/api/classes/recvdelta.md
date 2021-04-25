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

Name | Type | Default value |
:------ | :------ | :------ |
`props` | *Partial*<[*RecvDelta*](recvdelta.md)\> | {} |

**Returns:** [*RecvDelta*](recvdelta.md)

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:354](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/rtp/src/rtcp/rtpfb/twcc.ts#L354)

## Properties

### delta

• **delta**: *number*

micro sec

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:354](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/rtp/src/rtcp/rtpfb/twcc.ts#L354)

___

### parsed

• **parsed**: *boolean*= false

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:382](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/rtp/src/rtcp/rtpfb/twcc.ts#L382)

___

### type

• `Optional` **type**: [*TypeTCCPacketReceivedSmallDelta*](../enums/packetstatus.md#typetccpacketreceivedsmalldelta) \| [*TypeTCCPacketReceivedLargeDelta*](../enums/packetstatus.md#typetccpacketreceivedlargedelta)

optional (If undefined, it will be set automatically.)

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:350](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/rtp/src/rtcp/rtpfb/twcc.ts#L350)

## Methods

### deSerialize

▸ **deSerialize**(`data`: *Buffer*): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`data` | *Buffer* |

**Returns:** *void*

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:377](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/rtp/src/rtcp/rtpfb/twcc.ts#L377)

___

### parseDelta

▸ **parseDelta**(): *void*

**Returns:** *void*

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:383](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/rtp/src/rtcp/rtpfb/twcc.ts#L383)

___

### serialize

▸ **serialize**(): *Buffer*

**Returns:** *Buffer*

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:396](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/rtp/src/rtcp/rtpfb/twcc.ts#L396)

___

### deSerialize

▸ `Static`**deSerialize**(`data`: *Buffer*): [*RecvDelta*](recvdelta.md)

#### Parameters:

Name | Type |
:------ | :------ |
`data` | *Buffer* |

**Returns:** [*RecvDelta*](recvdelta.md)

Defined in: [rtp/src/rtcp/rtpfb/twcc.ts:360](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/rtp/src/rtcp/rtpfb/twcc.ts#L360)

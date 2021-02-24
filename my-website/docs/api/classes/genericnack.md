---
id: "genericnack"
title: "Class: GenericNack"
sidebar_label: "GenericNack"
custom_edit_url: null
hide_title: true
---

# Class: GenericNack

## Constructors

### constructor

\+ **new GenericNack**(`props?`: *Partial*<[*GenericNack*](genericnack.md)\>): [*GenericNack*](genericnack.md)

#### Parameters:

Name | Type |
:------ | :------ |
`props` | *Partial*<[*GenericNack*](genericnack.md)\> |

**Returns:** [*GenericNack*](genericnack.md)

Defined in: [rtp/src/rtcp/rtpfb/nack.ts:11](https://github.com/shinyoshiaki/werift-webrtc/blob/2cffe94/packages/rtp/src/rtcp/rtpfb/nack.ts#L11)

## Properties

### count

• `Readonly` **count**: *number*

Defined in: [rtp/src/rtcp/rtpfb/nack.ts:7](https://github.com/shinyoshiaki/werift-webrtc/blob/2cffe94/packages/rtp/src/rtcp/rtpfb/nack.ts#L7)

___

### header

• **header**: [*RtcpHeader*](rtcpheader.md)

Defined in: [rtp/src/rtcp/rtpfb/nack.ts:8](https://github.com/shinyoshiaki/werift-webrtc/blob/2cffe94/packages/rtp/src/rtcp/rtpfb/nack.ts#L8)

___

### lost

• **lost**: *number*[]

Defined in: [rtp/src/rtcp/rtpfb/nack.ts:11](https://github.com/shinyoshiaki/werift-webrtc/blob/2cffe94/packages/rtp/src/rtcp/rtpfb/nack.ts#L11)

___

### mediaSourceSsrc

• **mediaSourceSsrc**: *number*

Defined in: [rtp/src/rtcp/rtpfb/nack.ts:10](https://github.com/shinyoshiaki/werift-webrtc/blob/2cffe94/packages/rtp/src/rtcp/rtpfb/nack.ts#L10)

___

### senderSsrc

• **senderSsrc**: *number*

Defined in: [rtp/src/rtcp/rtpfb/nack.ts:9](https://github.com/shinyoshiaki/werift-webrtc/blob/2cffe94/packages/rtp/src/rtcp/rtpfb/nack.ts#L9)

___

### count

▪ `Static` **count**: *number*= 1

Defined in: [rtp/src/rtcp/rtpfb/nack.ts:6](https://github.com/shinyoshiaki/werift-webrtc/blob/2cffe94/packages/rtp/src/rtcp/rtpfb/nack.ts#L6)

## Methods

### serialize

▸ **serialize**(): *Buffer*

**Returns:** *Buffer*

Defined in: [rtp/src/rtcp/rtpfb/nack.ts:48](https://github.com/shinyoshiaki/werift-webrtc/blob/2cffe94/packages/rtp/src/rtcp/rtpfb/nack.ts#L48)

___

### deSerialize

▸ `Static`**deSerialize**(`data`: *Buffer*, `header`: [*RtcpHeader*](rtcpheader.md)): [*GenericNack*](genericnack.md)

#### Parameters:

Name | Type |
:------ | :------ |
`data` | *Buffer* |
`header` | [*RtcpHeader*](rtcpheader.md) |

**Returns:** [*GenericNack*](genericnack.md)

Defined in: [rtp/src/rtcp/rtpfb/nack.ts:24](https://github.com/shinyoshiaki/werift-webrtc/blob/2cffe94/packages/rtp/src/rtcp/rtpfb/nack.ts#L24)

---
id: "rtcpreceiverinfo"
title: "Class: RtcpReceiverInfo"
sidebar_label: "RtcpReceiverInfo"
custom_edit_url: null
hide_title: true
---

# Class: RtcpReceiverInfo

## Constructors

### constructor

\+ **new RtcpReceiverInfo**(`props?`: *Partial*<[*RtcpReceiverInfo*](rtcpreceiverinfo.md)\>): [*RtcpReceiverInfo*](rtcpreceiverinfo.md)

#### Parameters:

Name | Type |
:------ | :------ |
`props` | *Partial*<[*RtcpReceiverInfo*](rtcpreceiverinfo.md)\> |

**Returns:** [*RtcpReceiverInfo*](rtcpreceiverinfo.md)

Defined in: [rtp/src/rtcp/rr.ts:48](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/rtp/src/rtcp/rr.ts#L48)

## Properties

### dlsr

• **dlsr**: *number*

Defined in: [rtp/src/rtcp/rr.ts:48](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/rtp/src/rtcp/rr.ts#L48)

___

### fractionLost

• **fractionLost**: *number*

Defined in: [rtp/src/rtcp/rr.ts:43](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/rtp/src/rtcp/rr.ts#L43)

___

### highestSequence

• **highestSequence**: *number*

Defined in: [rtp/src/rtcp/rr.ts:45](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/rtp/src/rtcp/rr.ts#L45)

___

### jitter

• **jitter**: *number*

Defined in: [rtp/src/rtcp/rr.ts:46](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/rtp/src/rtcp/rr.ts#L46)

___

### lsr

• **lsr**: *number*

Defined in: [rtp/src/rtcp/rr.ts:47](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/rtp/src/rtcp/rr.ts#L47)

___

### packetsLost

• **packetsLost**: *number*

Defined in: [rtp/src/rtcp/rr.ts:44](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/rtp/src/rtcp/rr.ts#L44)

___

### ssrc

• **ssrc**: *number*

Defined in: [rtp/src/rtcp/rr.ts:42](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/rtp/src/rtcp/rr.ts#L42)

## Methods

### serialize

▸ **serialize**(): *Buffer*

**Returns:** *Buffer*

Defined in: [rtp/src/rtcp/rr.ts:54](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/rtp/src/rtcp/rr.ts#L54)

___

### deSerialize

▸ `Static`**deSerialize**(`data`: *Buffer*): [*RtcpReceiverInfo*](rtcpreceiverinfo.md)

#### Parameters:

Name | Type |
:------ | :------ |
`data` | *Buffer* |

**Returns:** [*RtcpReceiverInfo*](rtcpreceiverinfo.md)

Defined in: [rtp/src/rtcp/rr.ts:69](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/rtp/src/rtcp/rr.ts#L69)

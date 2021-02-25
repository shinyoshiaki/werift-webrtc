---
id: "rtcpsenderinfo"
title: "Class: RtcpSenderInfo"
sidebar_label: "RtcpSenderInfo"
custom_edit_url: null
hide_title: true
---

# Class: RtcpSenderInfo

## Constructors

### constructor

\+ **new RtcpSenderInfo**(`props?`: *Partial*<[*RtcpSenderInfo*](rtcpsenderinfo.md)\>): [*RtcpSenderInfo*](rtcpsenderinfo.md)

#### Parameters:

Name | Type |
:------ | :------ |
`props` | *Partial*<[*RtcpSenderInfo*](rtcpsenderinfo.md)\> |

**Returns:** [*RtcpSenderInfo*](rtcpsenderinfo.md)

Defined in: [rtp/src/rtcp/sr.ts:50](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/rtp/src/rtcp/sr.ts#L50)

## Properties

### ntpTimestamp

• **ntpTimestamp**: *bigint*

Defined in: [rtp/src/rtcp/sr.ts:47](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/rtp/src/rtcp/sr.ts#L47)

___

### octetCount

• **octetCount**: *number*

Defined in: [rtp/src/rtcp/sr.ts:50](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/rtp/src/rtcp/sr.ts#L50)

___

### packetCount

• **packetCount**: *number*

Defined in: [rtp/src/rtcp/sr.ts:49](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/rtp/src/rtcp/sr.ts#L49)

___

### rtpTimestamp

• **rtpTimestamp**: *number*

Defined in: [rtp/src/rtcp/sr.ts:48](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/rtp/src/rtcp/sr.ts#L48)

## Methods

### serialize

▸ **serialize**(): *Buffer*

**Returns:** *Buffer*

Defined in: [rtp/src/rtcp/sr.ts:56](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/rtp/src/rtcp/sr.ts#L56)

___

### deSerialize

▸ `Static`**deSerialize**(`data`: *Buffer*): [*RtcpSenderInfo*](rtcpsenderinfo.md)

#### Parameters:

Name | Type |
:------ | :------ |
`data` | *Buffer* |

**Returns:** [*RtcpSenderInfo*](rtcpsenderinfo.md)

Defined in: [rtp/src/rtcp/sr.ts:63](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/rtp/src/rtcp/sr.ts#L63)

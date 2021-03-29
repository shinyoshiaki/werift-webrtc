---
id: "rtcrtptransceiver"
title: "Class: RTCRtpTransceiver"
sidebar_label: "RTCRtpTransceiver"
custom_edit_url: null
hide_title: true
---

# Class: RTCRtpTransceiver

## Constructors

### constructor

\+ **new RTCRtpTransceiver**(`kind`: [*Kind*](../modules.md#kind), `receiver`: *RTCRtpReceiver*, `sender`: *RTCRtpSender*, `direction`: *sendonly* \| *sendrecv* \| *recvonly* \| *inactive*, `dtlsTransport`: [*RTCDtlsTransport*](rtcdtlstransport.md)): [*RTCRtpTransceiver*](rtcrtptransceiver.md)

#### Parameters:

Name | Type |
:------ | :------ |
`kind` | [*Kind*](../modules.md#kind) |
`receiver` | *RTCRtpReceiver* |
`sender` | *RTCRtpSender* |
`direction` | *sendonly* \| *sendrecv* \| *recvonly* \| *inactive* |
`dtlsTransport` | [*RTCDtlsTransport*](rtcdtlstransport.md) |

**Returns:** [*RTCRtpTransceiver*](rtcrtptransceiver.md)

Defined in: [webrtc/src/media/rtpTransceiver.ts:31](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/media/rtpTransceiver.ts#L31)

## Properties

### \_codecs

• **\_codecs**: [*RTCRtpCodecParameters*](rtcrtpcodecparameters.md)[]

Defined in: [webrtc/src/media/rtpTransceiver.ts:21](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/media/rtpTransceiver.ts#L21)

___

### direction

• **direction**: *sendonly* \| *sendrecv* \| *recvonly* \| *inactive*

___

### dtlsTransport

• **dtlsTransport**: [*RTCDtlsTransport*](rtcdtlstransport.md)

___

### headerExtensions

• **headerExtensions**: *RTCRtpHeaderExtensionParameters*[]

Defined in: [webrtc/src/media/rtpTransceiver.ts:29](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/media/rtpTransceiver.ts#L29)

___

### inactive

• **inactive**: *boolean*= false

Defined in: [webrtc/src/media/rtpTransceiver.ts:31](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/media/rtpTransceiver.ts#L31)

___

### kind

• `Readonly` **kind**: [*Kind*](../modules.md#kind)

___

### mLineIndex

• `Optional` **mLineIndex**: *number*

Defined in: [webrtc/src/media/rtpTransceiver.ts:20](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/media/rtpTransceiver.ts#L20)

___

### mid

• `Optional` **mid**: *string*

Defined in: [webrtc/src/media/rtpTransceiver.ts:19](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/media/rtpTransceiver.ts#L19)

___

### onTrack

• `Readonly` **onTrack**: *default*<[[*MediaStreamTrack*](mediastreamtrack.md)]\>

Defined in: [webrtc/src/media/rtpTransceiver.ts:18](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/media/rtpTransceiver.ts#L18)

___

### options

• **options**: *Partial*<[*TransceiverOptions*](../modules.md#transceiveroptions)\>

Defined in: [webrtc/src/media/rtpTransceiver.ts:30](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/media/rtpTransceiver.ts#L30)

___

### receiver

• `Readonly` **receiver**: *RTCRtpReceiver*

___

### sender

• `Readonly` **sender**: *RTCRtpSender*

___

### uuid

• `Readonly` **uuid**: *string*

Defined in: [webrtc/src/media/rtpTransceiver.ts:17](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/media/rtpTransceiver.ts#L17)

## Accessors

### codecs

• get **codecs**(): [*RTCRtpCodecParameters*](rtcrtpcodecparameters.md)[]

**Returns:** [*RTCRtpCodecParameters*](rtcrtpcodecparameters.md)[]

Defined in: [webrtc/src/media/rtpTransceiver.ts:22](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/media/rtpTransceiver.ts#L22)

• set **codecs**(`codecs`: [*RTCRtpCodecParameters*](rtcrtpcodecparameters.md)[]): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`codecs` | [*RTCRtpCodecParameters*](rtcrtpcodecparameters.md)[] |

**Returns:** *void*

Defined in: [webrtc/src/media/rtpTransceiver.ts:25](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/media/rtpTransceiver.ts#L25)

___

### msid

• get **msid**(): *string*

**Returns:** *string*

Defined in: [webrtc/src/media/rtpTransceiver.ts:41](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/media/rtpTransceiver.ts#L41)

## Methods

### addTrack

▸ **addTrack**(`track`: [*MediaStreamTrack*](mediastreamtrack.md)): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`track` | [*MediaStreamTrack*](mediastreamtrack.md) |

**Returns:** *void*

Defined in: [webrtc/src/media/rtpTransceiver.ts:45](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/media/rtpTransceiver.ts#L45)

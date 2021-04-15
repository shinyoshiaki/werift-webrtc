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

\+ **new RTCRtpTransceiver**(`kind`: [*Kind*](../modules.md#kind), `receiver`: *RTCRtpReceiver*, `sender`: *RTCRtpSender*, `direction`: *inactive* \| *sendonly* \| *recvonly* \| *sendrecv*, `dtlsTransport`: [*RTCDtlsTransport*](rtcdtlstransport.md)): [*RTCRtpTransceiver*](rtcrtptransceiver.md)

#### Parameters:

Name | Type |
:------ | :------ |
`kind` | [*Kind*](../modules.md#kind) |
`receiver` | *RTCRtpReceiver* |
`sender` | *RTCRtpSender* |
`direction` | *inactive* \| *sendonly* \| *recvonly* \| *sendrecv* |
`dtlsTransport` | [*RTCDtlsTransport*](rtcdtlstransport.md) |

**Returns:** [*RTCRtpTransceiver*](rtcrtptransceiver.md)

Defined in: [webrtc/src/media/rtpTransceiver.ts:47](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/media/rtpTransceiver.ts#L47)

## Properties

### \_codecs

• `Private` **\_codecs**: [*RTCRtpCodecParameters*](rtcrtpcodecparameters.md)[]= []

Defined in: [webrtc/src/media/rtpTransceiver.ts:35](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/media/rtpTransceiver.ts#L35)

___

### \_currentDirection

• `Private` `Optional` **\_currentDirection**: *inactive* \| *sendonly* \| *recvonly* \| *sendrecv* \| *stopped*

Defined in: [webrtc/src/media/rtpTransceiver.ts:23](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/media/rtpTransceiver.ts#L23)

___

### direction

• **direction**: *inactive* \| *sendonly* \| *recvonly* \| *sendrecv*

___

### dtlsTransport

• **dtlsTransport**: [*RTCDtlsTransport*](rtcdtlstransport.md)

___

### headerExtensions

• **headerExtensions**: *RTCRtpHeaderExtensionParameters*[]= []

Defined in: [webrtc/src/media/rtpTransceiver.ts:44](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/media/rtpTransceiver.ts#L44)

___

### kind

• `Readonly` **kind**: [*Kind*](../modules.md#kind)

___

### mLineIndex

• `Optional` **mLineIndex**: *number*

Defined in: [webrtc/src/media/rtpTransceiver.ts:21](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/media/rtpTransceiver.ts#L21)

___

### mid

• `Optional` **mid**: *string*

Defined in: [webrtc/src/media/rtpTransceiver.ts:20](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/media/rtpTransceiver.ts#L20)

___

### offerDirection

• **offerDirection**: *inactive* \| *sendonly* \| *recvonly* \| *sendrecv*

Defined in: [webrtc/src/media/rtpTransceiver.ts:34](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/media/rtpTransceiver.ts#L34)

___

### onTrack

• `Readonly` **onTrack**: *default*<[[*MediaStreamTrack*](mediastreamtrack.md)]\>

Defined in: [webrtc/src/media/rtpTransceiver.ts:19](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/media/rtpTransceiver.ts#L19)

___

### options

• **options**: *Partial*<[*TransceiverOptions*](../interfaces/transceiveroptions.md)\>= {}

Defined in: [webrtc/src/media/rtpTransceiver.ts:45](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/media/rtpTransceiver.ts#L45)

___

### receiver

• `Readonly` **receiver**: *RTCRtpReceiver*

___

### sender

• `Readonly` **sender**: *RTCRtpSender*

___

### stopped

• **stopped**: *boolean*= false

Defined in: [webrtc/src/media/rtpTransceiver.ts:47](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/media/rtpTransceiver.ts#L47)

___

### stopping

• **stopping**: *boolean*= false

Defined in: [webrtc/src/media/rtpTransceiver.ts:46](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/media/rtpTransceiver.ts#L46)

___

### usedForSender

• **usedForSender**: *boolean*= false

Defined in: [webrtc/src/media/rtpTransceiver.ts:22](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/media/rtpTransceiver.ts#L22)

___

### uuid

• `Readonly` **uuid**: *string*

Defined in: [webrtc/src/media/rtpTransceiver.ts:18](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/media/rtpTransceiver.ts#L18)

## Accessors

### codecs

• get **codecs**(): [*RTCRtpCodecParameters*](rtcrtpcodecparameters.md)[]

**Returns:** [*RTCRtpCodecParameters*](rtcrtpcodecparameters.md)[]

Defined in: [webrtc/src/media/rtpTransceiver.ts:36](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/media/rtpTransceiver.ts#L36)

• set **codecs**(`codecs`: [*RTCRtpCodecParameters*](rtcrtpcodecparameters.md)[]): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`codecs` | [*RTCRtpCodecParameters*](rtcrtpcodecparameters.md)[] |

**Returns:** *void*

Defined in: [webrtc/src/media/rtpTransceiver.ts:39](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/media/rtpTransceiver.ts#L39)

___

### currentDirection

• get **currentDirection**(): *inactive* \| *sendonly* \| *recvonly* \| *sendrecv*

**Returns:** *inactive* \| *sendonly* \| *recvonly* \| *sendrecv*

Defined in: [webrtc/src/media/rtpTransceiver.ts:30](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/media/rtpTransceiver.ts#L30)

• set **currentDirection**(`direction`: *inactive* \| *sendonly* \| *recvonly* \| *sendrecv*): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`direction` | *inactive* \| *sendonly* \| *recvonly* \| *sendrecv* |

**Returns:** *void*

Defined in: [webrtc/src/media/rtpTransceiver.ts:24](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/media/rtpTransceiver.ts#L24)

___

### msid

• get **msid**(): *string*

**Returns:** *string*

Defined in: [webrtc/src/media/rtpTransceiver.ts:57](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/media/rtpTransceiver.ts#L57)

## Methods

### addTrack

▸ **addTrack**(`track`: [*MediaStreamTrack*](mediastreamtrack.md)): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`track` | [*MediaStreamTrack*](mediastreamtrack.md) |

**Returns:** *void*

Defined in: [webrtc/src/media/rtpTransceiver.ts:61](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/media/rtpTransceiver.ts#L61)

___

### stop

▸ **stop**(): *void*

**Returns:** *void*

Defined in: [webrtc/src/media/rtpTransceiver.ts:68](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/media/rtpTransceiver.ts#L68)

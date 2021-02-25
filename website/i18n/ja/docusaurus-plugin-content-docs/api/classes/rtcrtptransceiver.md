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

\+ **new RTCRtpTransceiver**(`kind`: [*Kind*](../modules.md#kind), `receiver`: *RTCRtpReceiver*, `sender`: *RTCRtpSender*, `direction`: *sendonly* \| *sendrecv* \| *recvonly* \| *inactive*, `dtlsTransport`: *RTCDtlsTransport*): [*RTCRtpTransceiver*](rtcrtptransceiver.md)

#### Parameters:

Name | Type |
:------ | :------ |
`kind` | [*Kind*](../modules.md#kind) |
`receiver` | *RTCRtpReceiver* |
`sender` | *RTCRtpSender* |
`direction` | *sendonly* \| *sendrecv* \| *recvonly* \| *inactive* |
`dtlsTransport` | *RTCDtlsTransport* |

**Returns:** [*RTCRtpTransceiver*](rtcrtptransceiver.md)

Defined in: [webrtc/src/media/rtpTransceiver.ts:34](https://github.com/shinyoshiaki/werift-webrtc/blob/4277d59/packages/webrtc/src/media/rtpTransceiver.ts#L34)

## Properties

### \_codecs

• **\_codecs**: [*RTCRtpCodecParameters*](rtcrtpcodecparameters.md)[]

Defined in: [webrtc/src/media/rtpTransceiver.ts:23](https://github.com/shinyoshiaki/werift-webrtc/blob/4277d59/packages/webrtc/src/media/rtpTransceiver.ts#L23)

___

### direction

• **direction**: *sendonly* \| *sendrecv* \| *recvonly* \| *inactive*

___

### dtlsTransport

• **dtlsTransport**: *RTCDtlsTransport*

___

### headerExtensions

• **headerExtensions**: *RTCRtpHeaderExtensionParameters*[]

Defined in: [webrtc/src/media/rtpTransceiver.ts:31](https://github.com/shinyoshiaki/werift-webrtc/blob/4277d59/packages/webrtc/src/media/rtpTransceiver.ts#L31)

___

### inactive

• **inactive**: *boolean*= false

Defined in: [webrtc/src/media/rtpTransceiver.ts:34](https://github.com/shinyoshiaki/werift-webrtc/blob/4277d59/packages/webrtc/src/media/rtpTransceiver.ts#L34)

___

### kind

• `Readonly` **kind**: [*Kind*](../modules.md#kind)

___

### mLineIndex

• `Optional` **mLineIndex**: *undefined* \| *number*

Defined in: [webrtc/src/media/rtpTransceiver.ts:22](https://github.com/shinyoshiaki/werift-webrtc/blob/4277d59/packages/webrtc/src/media/rtpTransceiver.ts#L22)

___

### mid

• `Optional` **mid**: *undefined* \| *string*

Defined in: [webrtc/src/media/rtpTransceiver.ts:21](https://github.com/shinyoshiaki/werift-webrtc/blob/4277d59/packages/webrtc/src/media/rtpTransceiver.ts#L21)

___

### onTrack

• `Readonly` **onTrack**: *default*<[[*RtpTrack*](rtptrack.md)]\>

Defined in: [webrtc/src/media/rtpTransceiver.ts:20](https://github.com/shinyoshiaki/werift-webrtc/blob/4277d59/packages/webrtc/src/media/rtpTransceiver.ts#L20)

___

### options

• **options**: *Partial*<[*TransceiverOptions*](../modules.md#transceiveroptions)\>

Defined in: [webrtc/src/media/rtpTransceiver.ts:33](https://github.com/shinyoshiaki/werift-webrtc/blob/4277d59/packages/webrtc/src/media/rtpTransceiver.ts#L33)

___

### receiver

• `Readonly` **receiver**: *RTCRtpReceiver*

___

### sender

• `Readonly` **sender**: *RTCRtpSender*

___

### senderParams

• `Optional` **senderParams**: *undefined* \| *RTCRtpParameters*

Defined in: [webrtc/src/media/rtpTransceiver.ts:32](https://github.com/shinyoshiaki/werift-webrtc/blob/4277d59/packages/webrtc/src/media/rtpTransceiver.ts#L32)

___

### uuid

• `Readonly` **uuid**: *string*

Defined in: [webrtc/src/media/rtpTransceiver.ts:19](https://github.com/shinyoshiaki/werift-webrtc/blob/4277d59/packages/webrtc/src/media/rtpTransceiver.ts#L19)

## Accessors

### codecs

• get **codecs**(): [*RTCRtpCodecParameters*](rtcrtpcodecparameters.md)[]

**Returns:** [*RTCRtpCodecParameters*](rtcrtpcodecparameters.md)[]

Defined in: [webrtc/src/media/rtpTransceiver.ts:24](https://github.com/shinyoshiaki/werift-webrtc/blob/4277d59/packages/webrtc/src/media/rtpTransceiver.ts#L24)

• set **codecs**(`codecs`: [*RTCRtpCodecParameters*](rtcrtpcodecparameters.md)[]): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`codecs` | [*RTCRtpCodecParameters*](rtcrtpcodecparameters.md)[] |

**Returns:** *void*

Defined in: [webrtc/src/media/rtpTransceiver.ts:27](https://github.com/shinyoshiaki/werift-webrtc/blob/4277d59/packages/webrtc/src/media/rtpTransceiver.ts#L27)

___

### msid

• get **msid**(): *string*

**Returns:** *string*

Defined in: [webrtc/src/media/rtpTransceiver.ts:44](https://github.com/shinyoshiaki/werift-webrtc/blob/4277d59/packages/webrtc/src/media/rtpTransceiver.ts#L44)

## Methods

### addTrack

▸ **addTrack**(`track`: [*RtpTrack*](rtptrack.md)): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`track` | [*RtpTrack*](rtptrack.md) |

**Returns:** *void*

Defined in: [webrtc/src/media/rtpTransceiver.ts:48](https://github.com/shinyoshiaki/werift-webrtc/blob/4277d59/packages/webrtc/src/media/rtpTransceiver.ts#L48)

___

### replaceRtp

▸ **replaceRtp**(`header`: [*RtpHeader*](rtpheader.md)): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`header` | [*RtpHeader*](rtpheader.md) |

**Returns:** *void*

Defined in: [webrtc/src/media/rtpTransceiver.ts:61](https://github.com/shinyoshiaki/werift-webrtc/blob/4277d59/packages/webrtc/src/media/rtpTransceiver.ts#L61)

___

### sendRtp

▸ **sendRtp**(`rtp`: *Buffer* \| [*RtpPacket*](rtppacket.md)): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`rtp` | *Buffer* \| [*RtpPacket*](rtppacket.md) |

**Returns:** *void*

Defined in: [webrtc/src/media/rtpTransceiver.ts:65](https://github.com/shinyoshiaki/werift-webrtc/blob/4277d59/packages/webrtc/src/media/rtpTransceiver.ts#L65)

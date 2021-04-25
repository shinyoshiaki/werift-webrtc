---
id: "rtcdtlstransport"
title: "Class: RTCDtlsTransport"
sidebar_label: "RTCDtlsTransport"
custom_edit_url: null
hide_title: true
---

# Class: RTCDtlsTransport

## Constructors

### constructor

\+ **new RTCDtlsTransport**(`iceTransport`: [*RTCIceTransport*](rtcicetransport.md), `router`: *RtpRouter*, `certificates`: [*RTCCertificate*](rtccertificate.md)[], `srtpProfiles?`: *number*[]): [*RTCDtlsTransport*](rtcdtlstransport.md)

#### Parameters:

Name | Type | Default value |
:------ | :------ | :------ |
`iceTransport` | [*RTCIceTransport*](rtcicetransport.md) | - |
`router` | *RtpRouter* | - |
`certificates` | [*RTCCertificate*](rtccertificate.md)[] | - |
`srtpProfiles` | *number*[] | [] |

**Returns:** [*RTCDtlsTransport*](rtcdtlstransport.md)

Defined in: [webrtc/src/transport/dtls.ts:46](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/transport/dtls.ts#L46)

## Properties

### certificates

• `Readonly` **certificates**: [*RTCCertificate*](rtccertificate.md)[]

___

### dataReceiver

• `Optional` **dataReceiver**: (`buf`: *Buffer*) => *void*

#### Type declaration:

▸ (`buf`: *Buffer*): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`buf` | *Buffer* |

**Returns:** *void*

Defined in: [webrtc/src/transport/dtls.ts:39](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/transport/dtls.ts#L39)

Defined in: [webrtc/src/transport/dtls.ts:39](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/transport/dtls.ts#L39)

___

### dtls

• `Optional` **dtls**: *DtlsSocket*

Defined in: [webrtc/src/transport/dtls.ts:40](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/transport/dtls.ts#L40)

___

### iceTransport

• `Readonly` **iceTransport**: [*RTCIceTransport*](rtcicetransport.md)

___

### localCertificate

• `Private` `Optional` **localCertificate**: [*RTCCertificate*](rtccertificate.md)

Defined in: [webrtc/src/transport/dtls.ts:46](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/transport/dtls.ts#L46)

___

### onStateChange

• `Readonly` **onStateChange**: *default*<[*new* \| *connecting* \| *connected* \| *closed* \| *failed*]\>

Defined in: [webrtc/src/transport/dtls.ts:44](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/transport/dtls.ts#L44)

___

### role

• **role**: DtlsRole= "auto"

Defined in: [webrtc/src/transport/dtls.ts:35](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/transport/dtls.ts#L35)

___

### router

• `Readonly` **router**: *RtpRouter*

___

### srtcp

• **srtcp**: [*SrtcpSession*](srtcpsession.md)

Defined in: [webrtc/src/transport/dtls.ts:42](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/transport/dtls.ts#L42)

___

### srtp

• **srtp**: [*SrtpSession*](srtpsession.md)

Defined in: [webrtc/src/transport/dtls.ts:41](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/transport/dtls.ts#L41)

___

### srtpStarted

• **srtpStarted**: *boolean*= false

Defined in: [webrtc/src/transport/dtls.ts:36](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/transport/dtls.ts#L36)

___

### state

• **state**: *new* \| *connecting* \| *connected* \| *closed* \| *failed*= "new"

Defined in: [webrtc/src/transport/dtls.ts:34](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/transport/dtls.ts#L34)

___

### transportSequenceNumber

• **transportSequenceNumber**: *number*= 0

Defined in: [webrtc/src/transport/dtls.ts:37](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/transport/dtls.ts#L37)

## Accessors

### localParameters

• get **localParameters**(): *RTCDtlsParameters*

**Returns:** *RTCDtlsParameters*

Defined in: [webrtc/src/transport/dtls.ts:55](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/transport/dtls.ts#L55)

## Methods

### sendData

▸ `Readonly`**sendData**(`data`: *Buffer*): *Promise*<void\>

#### Parameters:

Name | Type |
:------ | :------ |
`data` | *Buffer* |

**Returns:** *Promise*<void\>

Defined in: [webrtc/src/transport/dtls.ts:174](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/transport/dtls.ts#L174)

___

### sendRtcp

▸ **sendRtcp**(`packets`: [*RtcpPacket*](../modules.md#rtcppacket)[]): *Promise*<void\>

#### Parameters:

Name | Type |
:------ | :------ |
`packets` | [*RtcpPacket*](../modules.md#rtcppacket)[] |

**Returns:** *Promise*<void\>

Defined in: [webrtc/src/transport/dtls.ts:185](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/transport/dtls.ts#L185)

___

### sendRtp

▸ **sendRtp**(`payload`: *Buffer*, `header`: [*RtpHeader*](rtpheader.md)): *number*

#### Parameters:

Name | Type |
:------ | :------ |
`payload` | *Buffer* |
`header` | [*RtpHeader*](rtpheader.md) |

**Returns:** *number*

Defined in: [webrtc/src/transport/dtls.ts:179](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/transport/dtls.ts#L179)

___

### setState

▸ `Private`**setState**(`state`: *new* \| *connecting* \| *connected* \| *closed* \| *failed*): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`state` | *new* \| *connecting* \| *connected* \| *closed* \| *failed* |

**Returns:** *void*

Defined in: [webrtc/src/transport/dtls.ts:195](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/transport/dtls.ts#L195)

___

### setupCertificate

▸ **setupCertificate**(): *Promise*<void\>

**Returns:** *Promise*<void\>

Defined in: [webrtc/src/transport/dtls.ts:61](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/transport/dtls.ts#L61)

___

### start

▸ **start**(`remoteParameters`: *RTCDtlsParameters*): *Promise*<void\>

#### Parameters:

Name | Type |
:------ | :------ |
`remoteParameters` | *RTCDtlsParameters* |

**Returns:** *Promise*<void\>

Defined in: [webrtc/src/transport/dtls.ts:82](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/transport/dtls.ts#L82)

___

### startSrtp

▸ **startSrtp**(): *void*

**Returns:** *void*

Defined in: [webrtc/src/transport/dtls.ts:135](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/transport/dtls.ts#L135)

___

### stop

▸ **stop**(): *Promise*<void\>

**Returns:** *Promise*<void\>

Defined in: [webrtc/src/transport/dtls.ts:202](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/transport/dtls.ts#L202)

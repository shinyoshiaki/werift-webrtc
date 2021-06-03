---
id: "modules"
title: "werift"
sidebar_label: "Exports"
sidebar_position: 0.5
custom_edit_url: null
---

## Enumerations

- [PacketChunk](enums/packetchunk.md)
- [PacketStatus](enums/packetstatus.md)

## Classes

- [EventTarget](classes/eventtarget.md)
- [GenericNack](classes/genericnack.md)
- [MediaStreamTrack](classes/mediastreamtrack.md)
- [PictureLossIndication](classes/picturelossindication.md)
- [PromiseQueue](classes/promisequeue.md)
- [RTCCertificate](classes/rtccertificate.md)
- [RTCDataChannel](classes/rtcdatachannel.md)
- [RTCDtlsTransport](classes/rtcdtlstransport.md)
- [RTCIceGatherer](classes/rtcicegatherer.md)
- [RTCIceTransport](classes/rtcicetransport.md)
- [RTCPeerConnection](classes/rtcpeerconnection.md)
- [RTCRtcpFeedback](classes/rtcrtcpfeedback.md)
- [RTCRtcpParameters](classes/rtcrtcpparameters.md)
- [RTCRtpCodecCapability](classes/rtcrtpcodeccapability.md)
- [RTCRtpCodecParameters](classes/rtcrtpcodecparameters.md)
- [RTCRtpCodingParameters](classes/rtcrtpcodingparameters.md)
- [RTCRtpHeaderExtensionParameters](classes/rtcrtpheaderextensionparameters.md)
- [RTCRtpRtxParameters](classes/rtcrtprtxparameters.md)
- [RTCRtpSimulcastParameters](classes/rtcrtpsimulcastparameters.md)
- [RTCRtpTransceiver](classes/rtcrtptransceiver.md)
- [RTCSctpTransport](classes/rtcsctptransport.md)
- [RTCSessionDescription](classes/rtcsessiondescription.md)
- [ReceiverEstimatedMaxBitrate](classes/receiverestimatedmaxbitrate.md)
- [RecvDelta](classes/recvdelta.md)
- [RtcpHeader](classes/rtcpheader.md)
- [RtcpPacketConverter](classes/rtcppacketconverter.md)
- [RtcpPayloadSpecificFeedback](classes/rtcppayloadspecificfeedback.md)
- [RtcpReceiverInfo](classes/rtcpreceiverinfo.md)
- [RtcpRrPacket](classes/rtcprrpacket.md)
- [RtcpSenderInfo](classes/rtcpsenderinfo.md)
- [RtcpSourceDescriptionPacket](classes/rtcpsourcedescriptionpacket.md)
- [RtcpSrPacket](classes/rtcpsrpacket.md)
- [RtcpTransportLayerFeedback](classes/rtcptransportlayerfeedback.md)
- [RtpBuilder](classes/rtpbuilder.md)
- [RtpHeader](classes/rtpheader.md)
- [RtpPacket](classes/rtppacket.md)
- [RunLengthChunk](classes/runlengthchunk.md)
- [SourceDescriptionChunk](classes/sourcedescriptionchunk.md)
- [SourceDescriptionItem](classes/sourcedescriptionitem.md)
- [SrtcpSession](classes/srtcpsession.md)
- [SrtpSession](classes/srtpsession.md)
- [StatusVectorChunk](classes/statusvectorchunk.md)
- [TransportWideCC](classes/transportwidecc.md)

## Interfaces

- [PeerConfig](interfaces/peerconfig.md)
- [RTCRtpParameters](interfaces/rtcrtpparameters.md)
- [RTCRtpReceiveParameters](interfaces/rtcrtpreceiveparameters.md)
- [TransceiverOptions](interfaces/transceiveroptions.md)

## Type aliases

### Direction

Ƭ **Direction**: typeof `Directions`[`number`]

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:87](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/media/rtpTransceiver.ts#L87)

___

### Extension

Ƭ **Extension**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `id` | `number` |
| `payload` | `Buffer` |

#### Defined in

[packages/rtp/src/rtp/rtp.ts:3](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtp/rtp.ts#L3)

___

### Kind

Ƭ **Kind**: ``"audio"`` \| ``"video"`` \| ``"application"`` \| ``"unknown"``

#### Defined in

[packages/webrtc/src/types/domain.ts:1](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/types/domain.ts#L1)

___

### RTCIceCandidateJSON

Ƭ **RTCIceCandidateJSON**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `candidate` | `string` |
| `sdpMLineIndex` | `number` |
| `sdpMid` | `string` |

#### Defined in

[packages/webrtc/src/transport/ice.ts:169](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/ice.ts#L169)

___

### RTCPFB

Ƭ **RTCPFB**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `parameter?` | `string` |
| `type` | `string` |

#### Defined in

[packages/webrtc/src/media/parameters.ts:23](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/media/parameters.ts#L23)

___

### RtcpPacket

Ƭ **RtcpPacket**: [RtcpRrPacket](classes/rtcprrpacket.md) \| [RtcpSrPacket](classes/rtcpsrpacket.md) \| [RtcpPayloadSpecificFeedback](classes/rtcppayloadspecificfeedback.md) \| [RtcpSourceDescriptionPacket](classes/rtcpsourcedescriptionpacket.md) \| [RtcpTransportLayerFeedback](classes/rtcptransportlayerfeedback.md)

#### Defined in

[packages/rtp/src/rtcp/rtcp.ts:12](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/rtp/src/rtcp/rtcp.ts#L12)

## Variables

### RTP\_EXTENSION\_URI

• `Const` **RTP\_EXTENSION\_URI**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `absSendTime` | ``"http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time"`` |
| `sdesMid` | ``"urn:ietf:params:rtp-hdrext:sdes:mid"`` |
| `sdesRTPStreamID` | ``"urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id"`` |
| `transportWideCC` | ``"http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01"`` |

#### Defined in

[packages/webrtc/src/extension/rtpExtension.ts:3](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/extension/rtpExtension.ts#L3)

## Functions

### andDirection

▸ `Const` **andDirection**(`a`, `b`): ``"inactive"`` \| ``"sendonly"`` \| ``"recvonly"`` \| ``"sendrecv"``

#### Parameters

| Name | Type |
| :------ | :------ |
| `a` | ``"inactive"`` \| ``"sendonly"`` \| ``"recvonly"`` \| ``"sendrecv"`` |
| `b` | ``"inactive"`` \| ``"sendonly"`` \| ``"recvonly"`` \| ``"sendrecv"`` |

#### Returns

``"inactive"`` \| ``"sendonly"`` \| ``"recvonly"`` \| ``"sendrecv"``

#### Defined in

[packages/webrtc/src/utils.ts:43](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/utils.ts#L43)

___

### divide

▸ **divide**(`from`, `split`): [`string`, `string`]

#### Parameters

| Name | Type |
| :------ | :------ |
| `from` | `string` |
| `split` | `string` |

#### Returns

[`string`, `string`]

#### Defined in

[packages/webrtc/src/helper.ts:7](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/helper.ts#L7)

___

### enumerate

▸ **enumerate**<T\>(`arr`): [`number`, `T`][]

#### Type parameters

| Name |
| :------ |
| `T` |

#### Parameters

| Name | Type |
| :------ | :------ |
| `arr` | `T`[] |

#### Returns

[`number`, `T`][]

#### Defined in

[packages/webrtc/src/helper.ts:3](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/helper.ts#L3)

___

### fingerprint

▸ **fingerprint**(`file`, `hashName`): `any`

#### Parameters

| Name | Type |
| :------ | :------ |
| `file` | `Buffer` |
| `hashName` | `string` |

#### Returns

`any`

#### Defined in

[packages/webrtc/src/utils.ts:15](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/utils.ts#L15)

___

### isDtls

▸ **isDtls**(`buf`): `boolean`

#### Parameters

| Name | Type |
| :------ | :------ |
| `buf` | `Buffer` |

#### Returns

`boolean`

#### Defined in

[packages/webrtc/src/utils.ts:24](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/utils.ts#L24)

___

### isMedia

▸ **isMedia**(`buf`): `boolean`

#### Parameters

| Name | Type |
| :------ | :------ |
| `buf` | `Buffer` |

#### Returns

`boolean`

#### Defined in

[packages/webrtc/src/utils.ts:29](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/utils.ts#L29)

___

### isRtcp

▸ **isRtcp**(`buf`): `boolean`

#### Parameters

| Name | Type |
| :------ | :------ |
| `buf` | `Buffer` |

#### Returns

`boolean`

#### Defined in

[packages/webrtc/src/utils.ts:34](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/utils.ts#L34)

___

### microTime

▸ `Const` **microTime**(): `number`

#### Returns

`number`

#### Defined in

[packages/webrtc/src/utils.ts:55](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/utils.ts#L55)

___

### milliTime

▸ `Const` **milliTime**(): `number`

#### Returns

`number`

#### Defined in

[packages/webrtc/src/utils.ts:57](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/utils.ts#L57)

___

### ntpTime

▸ `Const` **ntpTime**(): `bigint`

#### Returns

`bigint`

#### Defined in

[packages/webrtc/src/utils.ts:59](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/utils.ts#L59)

___

### orDirection

▸ `Const` **orDirection**(`a`, `b`): ``"inactive"`` \| ``"sendonly"`` \| ``"recvonly"`` \| ``"sendrecv"``

#### Parameters

| Name | Type |
| :------ | :------ |
| `a` | ``"inactive"`` \| ``"sendonly"`` \| ``"recvonly"`` \| ``"sendrecv"`` |
| `b` | ``"inactive"`` \| ``"sendonly"`` \| ``"recvonly"`` \| ``"sendrecv"`` |

#### Returns

``"inactive"`` \| ``"sendonly"`` \| ``"recvonly"`` \| ``"sendrecv"``

#### Defined in

[packages/webrtc/src/utils.ts:46](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/utils.ts#L46)

___

### parseIceServers

▸ **parseIceServers**(`iceServers`): `Object`

#### Parameters

| Name | Type |
| :------ | :------ |
| `iceServers` | `IceServer`[] |

#### Returns

`Object`

| Name | Type |
| :------ | :------ |
| `stunServer` | `undefined` \| `Address` |
| `turnPassword` | `undefined` \| `string` |
| `turnServer` | `undefined` \| `Address` |
| `turnUsername` | `undefined` \| `string` |

#### Defined in

[packages/webrtc/src/utils.ts:100](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/utils.ts#L100)

___

### random16

▸ **random16**(): `any`

#### Returns

`any`

#### Defined in

[packages/webrtc/src/utils.ts:76](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/utils.ts#L76)

___

### random32

▸ **random32**(): `bigint`

#### Returns

`bigint`

#### Defined in

[packages/webrtc/src/utils.ts:80](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/utils.ts#L80)

___

### reverseDirection

▸ **reverseDirection**(`dir`): [Direction](modules.md#direction)

#### Parameters

| Name | Type |
| :------ | :------ |
| `dir` | [Direction](modules.md#direction) |

#### Returns

[Direction](modules.md#direction)

#### Defined in

[packages/webrtc/src/utils.ts:49](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/utils.ts#L49)

___

### reverseSimulcastDirection

▸ **reverseSimulcastDirection**(`dir`): ``"send"`` \| ``"recv"``

#### Parameters

| Name | Type |
| :------ | :------ |
| `dir` | ``"recv"`` \| ``"send"`` |

#### Returns

``"send"`` \| ``"recv"``

#### Defined in

[packages/webrtc/src/utils.ts:38](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/utils.ts#L38)

___

### uint16Add

▸ **uint16Add**(`a`, `b`): `number`

#### Parameters

| Name | Type |
| :------ | :------ |
| `a` | `number` |
| `b` | `number` |

#### Returns

`number`

#### Defined in

[packages/webrtc/src/utils.ts:88](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/utils.ts#L88)

___

### uint24

▸ **uint24**(`v`): `number`

#### Parameters

| Name | Type |
| :------ | :------ |
| `v` | `number` |

#### Returns

`number`

#### Defined in

[packages/webrtc/src/utils.ts:96](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/utils.ts#L96)

___

### uint32Add

▸ **uint32Add**(`a`, `b`): `bigint`

#### Parameters

| Name | Type |
| :------ | :------ |
| `a` | `bigint` |
| `b` | `bigint` |

#### Returns

`bigint`

#### Defined in

[packages/webrtc/src/utils.ts:92](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/utils.ts#L92)

___

### uint8Add

▸ **uint8Add**(`a`, `b`): `number`

#### Parameters

| Name | Type |
| :------ | :------ |
| `a` | `number` |
| `b` | `number` |

#### Returns

`number`

#### Defined in

[packages/webrtc/src/utils.ts:84](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/utils.ts#L84)

___

### useAbsSendTime

▸ **useAbsSendTime**(): [RTCRtpHeaderExtensionParameters](classes/rtcrtpheaderextensionparameters.md)

#### Returns

[RTCRtpHeaderExtensionParameters](classes/rtcrtpheaderextensionparameters.md)

#### Defined in

[packages/webrtc/src/extension/rtpExtension.ts:29](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/extension/rtpExtension.ts#L29)

___

### useFIR

▸ `Const` **useFIR**(): [RTCPFB](modules.md#rtcpfb)

#### Returns

[RTCPFB](modules.md#rtcpfb)

#### Defined in

[packages/webrtc/src/extension/rtcpFeedback.ts:3](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/extension/rtcpFeedback.ts#L3)

___

### useNACK

▸ `Const` **useNACK**(): [RTCPFB](modules.md#rtcpfb)

#### Returns

[RTCPFB](modules.md#rtcpfb)

#### Defined in

[packages/webrtc/src/extension/rtcpFeedback.ts:5](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/extension/rtcpFeedback.ts#L5)

___

### usePLI

▸ `Const` **usePLI**(): [RTCPFB](modules.md#rtcpfb)

#### Returns

[RTCPFB](modules.md#rtcpfb)

#### Defined in

[packages/webrtc/src/extension/rtcpFeedback.ts:7](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/extension/rtcpFeedback.ts#L7)

___

### useREMB

▸ `Const` **useREMB**(): [RTCPFB](modules.md#rtcpfb)

#### Returns

[RTCPFB](modules.md#rtcpfb)

#### Defined in

[packages/webrtc/src/extension/rtcpFeedback.ts:9](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/extension/rtcpFeedback.ts#L9)

___

### useSdesMid

▸ **useSdesMid**(): [RTCRtpHeaderExtensionParameters](classes/rtcrtpheaderextensionparameters.md)

#### Returns

[RTCRtpHeaderExtensionParameters](classes/rtcrtpheaderextensionparameters.md)

#### Defined in

[packages/webrtc/src/extension/rtpExtension.ts:11](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/extension/rtpExtension.ts#L11)

___

### useSdesRTPStreamID

▸ **useSdesRTPStreamID**(): [RTCRtpHeaderExtensionParameters](classes/rtcrtpheaderextensionparameters.md)

#### Returns

[RTCRtpHeaderExtensionParameters](classes/rtcrtpheaderextensionparameters.md)

#### Defined in

[packages/webrtc/src/extension/rtpExtension.ts:17](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/extension/rtpExtension.ts#L17)

___

### useTWCC

▸ `Const` **useTWCC**(): [RTCPFB](modules.md#rtcpfb)

#### Returns

[RTCPFB](modules.md#rtcpfb)

#### Defined in

[packages/webrtc/src/extension/rtcpFeedback.ts:11](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/extension/rtcpFeedback.ts#L11)

___

### useTransportWideCC

▸ **useTransportWideCC**(): [RTCRtpHeaderExtensionParameters](classes/rtcrtpheaderextensionparameters.md)

#### Returns

[RTCRtpHeaderExtensionParameters](classes/rtcrtpheaderextensionparameters.md)

#### Defined in

[packages/webrtc/src/extension/rtpExtension.ts:23](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/extension/rtpExtension.ts#L23)

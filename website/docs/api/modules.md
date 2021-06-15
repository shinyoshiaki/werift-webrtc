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
- [GroupDescription](classes/groupdescription.md)
- [IceCandidate](classes/icecandidate.md)
- [MediaDescription](classes/mediadescription.md)
- [MediaStream](classes/mediastream.md)
- [MediaStreamTrack](classes/mediastreamtrack.md)
- [PictureLossIndication](classes/picturelossindication.md)
- [PromiseQueue](classes/promisequeue.md)
- [RTCCertificate](classes/rtccertificate.md)
- [RTCDataChannel](classes/rtcdatachannel.md)
- [RTCDataChannelParameters](classes/rtcdatachannelparameters.md)
- [RTCDtlsFingerprint](classes/rtcdtlsfingerprint.md)
- [RTCDtlsParameters](classes/rtcdtlsparameters.md)
- [RTCDtlsTransport](classes/rtcdtlstransport.md)
- [RTCIceGatherer](classes/rtcicegatherer.md)
- [RTCIceParameters](classes/rtciceparameters.md)
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
- [RTCSctpCapabilities](classes/rtcsctpcapabilities.md)
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
- [SessionDescription](classes/sessiondescription.md)
- [SourceDescriptionChunk](classes/sourcedescriptionchunk.md)
- [SourceDescriptionItem](classes/sourcedescriptionitem.md)
- [SrtcpSession](classes/srtcpsession.md)
- [SrtpSession](classes/srtpsession.md)
- [SsrcDescription](classes/ssrcdescription.md)
- [StatusVectorChunk](classes/statusvectorchunk.md)
- [TransportWideCC](classes/transportwidecc.md)

## Interfaces

- [MessageEvent](interfaces/messageevent.md)
- [PeerConfig](interfaces/peerconfig.md)
- [RTCDataChannelEvent](interfaces/rtcdatachannelevent.md)
- [RTCErrorEvent](interfaces/rtcerrorevent.md)
- [RTCPeerConnectionIceEvent](interfaces/rtcpeerconnectioniceevent.md)
- [RTCRtpParameters](interfaces/rtcrtpparameters.md)
- [RTCRtpReceiveParameters](interfaces/rtcrtpreceiveparameters.md)
- [RTCTrackEvent](interfaces/rtctrackevent.md)
- [TransceiverOptions](interfaces/transceiveroptions.md)

## Type aliases

### ConnectionState

Ƭ **ConnectionState**: typeof [ConnectionStates](modules.md#connectionstates)[`number`]

#### Defined in

[packages/webrtc/src/types/domain.ts:23](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/types/domain.ts#L23)

___

### DCState

Ƭ **DCState**: ``"open"`` \| ``"closed"`` \| ``"connecting"`` \| ``"closing"``

#### Defined in

[packages/webrtc/src/dataChannel.ts:132](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/dataChannel.ts#L132)

___

### Direction

Ƭ **Direction**: typeof [Directions](modules.md#directions)[`number`]

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:87](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/media/rtpTransceiver.ts#L87)

___

### DtlsRole

Ƭ **DtlsRole**: ``"auto"`` \| ``"server"`` \| ``"client"``

#### Defined in

[packages/webrtc/src/transport/dtls.ts:213](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/transport/dtls.ts#L213)

___

### DtlsState

Ƭ **DtlsState**: typeof [DtlsStates](modules.md#dtlsstates)[`number`]

#### Defined in

[packages/webrtc/src/transport/dtls.ts:211](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/transport/dtls.ts#L211)

___

### Extension

Ƭ **Extension**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `id` | `number` |
| `payload` | `Buffer` |

#### Defined in

[packages/rtp/src/rtp/rtp.ts:3](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtp/rtp.ts#L3)

___

### IceGathererState

Ƭ **IceGathererState**: typeof [IceGathererStates](modules.md#icegathererstates)[`number`]

#### Defined in

[packages/webrtc/src/transport/ice.ts:96](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/transport/ice.ts#L96)

___

### Kind

Ƭ **Kind**: ``"audio"`` \| ``"video"`` \| ``"application"`` \| ``"unknown"``

#### Defined in

[packages/webrtc/src/types/domain.ts:1](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/types/domain.ts#L1)

___

### RTCIceCandidate

Ƭ **RTCIceCandidate**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `candidate` | `string` |
| `sdpMLineIndex` | `number` |
| `sdpMid` | `string` |

#### Defined in

[packages/webrtc/src/transport/ice.ts:169](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/transport/ice.ts#L169)

___

### RTCIceConnectionState

Ƭ **RTCIceConnectionState**: typeof [IceTransportStates](modules.md#icetransportstates)[`number`]

#### Defined in

[packages/webrtc/src/transport/ice.ts:93](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/transport/ice.ts#L93)

___

### RTCIceServer

Ƭ **RTCIceServer**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `credential?` | `string` |
| `urls` | `string` |
| `username?` | `string` |

#### Defined in

[packages/webrtc/src/peerConnection.ts:1154](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L1154)

___

### RTCPFB

Ƭ **RTCPFB**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `parameter?` | `string` |
| `type` | `string` |

#### Defined in

[packages/webrtc/src/media/parameters.ts:23](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/media/parameters.ts#L23)

___

### RTCSignalingState

Ƭ **RTCSignalingState**: typeof [SignalingStates](modules.md#signalingstates)[`number`]

#### Defined in

[packages/webrtc/src/types/domain.ts:12](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/types/domain.ts#L12)

___

### RtcpPacket

Ƭ **RtcpPacket**: [RtcpRrPacket](classes/rtcprrpacket.md) \| [RtcpSrPacket](classes/rtcpsrpacket.md) \| [RtcpPayloadSpecificFeedback](classes/rtcppayloadspecificfeedback.md) \| [RtcpSourceDescriptionPacket](classes/rtcpsourcedescriptionpacket.md) \| [RtcpTransportLayerFeedback](classes/rtcptransportlayerfeedback.md)

#### Defined in

[packages/rtp/src/rtcp/rtcp.ts:12](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/rtcp/rtcp.ts#L12)

## Variables

### ConnectionStates

• `Const` **ConnectionStates**: readonly [``"closed"``, ``"failed"``, ``"disconnected"``, ``"new"``, ``"connecting"``, ``"connected"``]

#### Defined in

[packages/webrtc/src/types/domain.ts:14](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/types/domain.ts#L14)

___

### Directions

• `Const` **Directions**: readonly [``"inactive"``, ``"sendonly"``, ``"recvonly"``, ``"sendrecv"``]

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:80](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/media/rtpTransceiver.ts#L80)

___

### DtlsStates

• `Const` **DtlsStates**: readonly [``"new"``, ``"connecting"``, ``"connected"``, ``"closed"``, ``"failed"``]

#### Defined in

[packages/webrtc/src/transport/dtls.ts:204](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/transport/dtls.ts#L204)

___

### IceGathererStates

• `Const` **IceGathererStates**: readonly [``"new"``, ``"gathering"``, ``"complete"``]

#### Defined in

[packages/webrtc/src/transport/ice.ts:95](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/transport/ice.ts#L95)

___

### IceTransportStates

• `Const` **IceTransportStates**: readonly [``"new"``, ``"checking"``, ``"connected"``, ``"completed"``, ``"disconnected"``, ``"failed"``, ``"closed"``]

#### Defined in

[packages/webrtc/src/transport/ice.ts:84](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/transport/ice.ts#L84)

___

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

[packages/webrtc/src/extension/rtpExtension.ts:3](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/extension/rtpExtension.ts#L3)

___

### SignalingStates

• `Const` **SignalingStates**: readonly [``"stable"``, ``"have-local-offer"``, ``"have-remote-offer"``, ``"have-local-pranswer"``, ``"have-remote-pranswer"``, ``"closed"``]

#### Defined in

[packages/webrtc/src/types/domain.ts:3](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/types/domain.ts#L3)

___

### defaultPeerConfig

• `Const` **defaultPeerConfig**: [PeerConfig](interfaces/peerconfig.md)

#### Defined in

[packages/webrtc/src/peerConnection.ts:1160](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L1160)

## Functions

### addSDPHeader

▸ **addSDPHeader**(`type`, `description`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `type` | ``"offer"`` \| ``"answer"`` |
| `description` | [SessionDescription](classes/sessiondescription.md) |

#### Returns

`void`

#### Defined in

[packages/webrtc/src/sdp.ts:604](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/sdp.ts#L604)

___

### addTransportDescription

▸ **addTransportDescription**(`media`, `dtlsTransport`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `media` | [MediaDescription](classes/mediadescription.md) |
| `dtlsTransport` | [RTCDtlsTransport](classes/rtcdtlstransport.md) |

#### Returns

`void`

#### Defined in

[packages/webrtc/src/peerConnection.ts:1095](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L1095)

___

### allocateMid

▸ **allocateMid**(`mids`): `string`

#### Parameters

| Name | Type |
| :------ | :------ |
| `mids` | `Set`<string\> |

#### Returns

`string`

#### Defined in

[packages/webrtc/src/peerConnection.ts:1129](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L1129)

___

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

[packages/webrtc/src/utils.ts:43](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/utils.ts#L43)

___

### candidateFromIce

▸ **candidateFromIce**(`c`): [IceCandidate](classes/icecandidate.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `c` | `Candidate` |

#### Returns

[IceCandidate](classes/icecandidate.md)

#### Defined in

[packages/webrtc/src/transport/ice.ts:138](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/transport/ice.ts#L138)

___

### candidateFromSdp

▸ **candidateFromSdp**(`sdp`): [IceCandidate](classes/icecandidate.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `sdp` | `string` |

#### Returns

[IceCandidate](classes/icecandidate.md)

#### Defined in

[packages/webrtc/src/sdp.ts:563](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/sdp.ts#L563)

___

### candidateToIce

▸ **candidateToIce**(`x`): `Candidate`

#### Parameters

| Name | Type |
| :------ | :------ |
| `x` | [IceCandidate](classes/icecandidate.md) |

#### Returns

`Candidate`

#### Defined in

[packages/webrtc/src/transport/ice.ts:154](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/transport/ice.ts#L154)

___

### candidateToSdp

▸ **candidateToSdp**(`c`): `string`

#### Parameters

| Name | Type |
| :------ | :------ |
| `c` | [IceCandidate](classes/icecandidate.md) |

#### Returns

`string`

#### Defined in

[packages/webrtc/src/sdp.ts:507](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/sdp.ts#L507)

___

### createMediaDescriptionForSctp

▸ **createMediaDescriptionForSctp**(`sctp`, `mid`): [MediaDescription](classes/mediadescription.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `sctp` | [RTCSctpTransport](classes/rtcsctptransport.md) |
| `mid` | `string` |

#### Returns

[MediaDescription](classes/mediadescription.md)

#### Defined in

[packages/webrtc/src/peerConnection.ts:1077](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L1077)

___

### createMediaDescriptionForTransceiver

▸ **createMediaDescriptionForTransceiver**(`transceiver`, `cname`, `direction`, `mid`): [MediaDescription](classes/mediadescription.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `transceiver` | [RTCRtpTransceiver](classes/rtcrtptransceiver.md) |
| `cname` | `string` |
| `direction` | [Direction](modules.md#direction) |
| `mid` | `string` |

#### Returns

[MediaDescription](classes/mediadescription.md)

#### Defined in

[packages/webrtc/src/peerConnection.ts:1043](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L1043)

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

[packages/webrtc/src/helper.ts:7](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/helper.ts#L7)

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

[packages/webrtc/src/helper.ts:3](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/helper.ts#L3)

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

[packages/webrtc/src/utils.ts:15](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/utils.ts#L15)

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

[packages/webrtc/src/utils.ts:24](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/utils.ts#L24)

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

[packages/webrtc/src/utils.ts:29](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/utils.ts#L29)

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

[packages/webrtc/src/utils.ts:34](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/utils.ts#L34)

___

### microTime

▸ `Const` **microTime**(): `number`

#### Returns

`number`

#### Defined in

[packages/webrtc/src/utils.ts:55](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/utils.ts#L55)

___

### milliTime

▸ `Const` **milliTime**(): `number`

#### Returns

`number`

#### Defined in

[packages/webrtc/src/utils.ts:57](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/utils.ts#L57)

___

### ntpTime

▸ `Const` **ntpTime**(): `bigint`

#### Returns

`bigint`

#### Defined in

[packages/webrtc/src/utils.ts:59](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/utils.ts#L59)

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

[packages/webrtc/src/utils.ts:46](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/utils.ts#L46)

___

### parseIceServers

▸ **parseIceServers**(`iceServers`): `Object`

#### Parameters

| Name | Type |
| :------ | :------ |
| `iceServers` | [RTCIceServer](modules.md#rtciceserver)[] |

#### Returns

`Object`

| Name | Type |
| :------ | :------ |
| `stunServer` | `undefined` \| `Address` |
| `turnPassword` | `undefined` \| `string` |
| `turnServer` | `undefined` \| `Address` |
| `turnUsername` | `undefined` \| `string` |

#### Defined in

[packages/webrtc/src/utils.ts:100](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/utils.ts#L100)

___

### random16

▸ **random16**(): `any`

#### Returns

`any`

#### Defined in

[packages/webrtc/src/utils.ts:76](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/utils.ts#L76)

___

### random32

▸ **random32**(): `bigint`

#### Returns

`bigint`

#### Defined in

[packages/webrtc/src/utils.ts:80](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/utils.ts#L80)

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

[packages/webrtc/src/utils.ts:49](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/utils.ts#L49)

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

[packages/webrtc/src/utils.ts:38](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/utils.ts#L38)

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

[packages/webrtc/src/utils.ts:88](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/utils.ts#L88)

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

[packages/webrtc/src/utils.ts:96](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/utils.ts#L96)

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

[packages/webrtc/src/utils.ts:92](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/utils.ts#L92)

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

[packages/webrtc/src/utils.ts:84](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/utils.ts#L84)

___

### useAbsSendTime

▸ **useAbsSendTime**(): [RTCRtpHeaderExtensionParameters](classes/rtcrtpheaderextensionparameters.md)

#### Returns

[RTCRtpHeaderExtensionParameters](classes/rtcrtpheaderextensionparameters.md)

#### Defined in

[packages/webrtc/src/extension/rtpExtension.ts:29](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/extension/rtpExtension.ts#L29)

___

### useFIR

▸ `Const` **useFIR**(): [RTCPFB](modules.md#rtcpfb)

#### Returns

[RTCPFB](modules.md#rtcpfb)

#### Defined in

[packages/webrtc/src/extension/rtcpFeedback.ts:3](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/extension/rtcpFeedback.ts#L3)

___

### useNACK

▸ `Const` **useNACK**(): [RTCPFB](modules.md#rtcpfb)

#### Returns

[RTCPFB](modules.md#rtcpfb)

#### Defined in

[packages/webrtc/src/extension/rtcpFeedback.ts:5](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/extension/rtcpFeedback.ts#L5)

___

### usePLI

▸ `Const` **usePLI**(): [RTCPFB](modules.md#rtcpfb)

#### Returns

[RTCPFB](modules.md#rtcpfb)

#### Defined in

[packages/webrtc/src/extension/rtcpFeedback.ts:7](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/extension/rtcpFeedback.ts#L7)

___

### useREMB

▸ `Const` **useREMB**(): [RTCPFB](modules.md#rtcpfb)

#### Returns

[RTCPFB](modules.md#rtcpfb)

#### Defined in

[packages/webrtc/src/extension/rtcpFeedback.ts:9](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/extension/rtcpFeedback.ts#L9)

___

### useSdesMid

▸ **useSdesMid**(): [RTCRtpHeaderExtensionParameters](classes/rtcrtpheaderextensionparameters.md)

#### Returns

[RTCRtpHeaderExtensionParameters](classes/rtcrtpheaderextensionparameters.md)

#### Defined in

[packages/webrtc/src/extension/rtpExtension.ts:11](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/extension/rtpExtension.ts#L11)

___

### useSdesRTPStreamID

▸ **useSdesRTPStreamID**(): [RTCRtpHeaderExtensionParameters](classes/rtcrtpheaderextensionparameters.md)

#### Returns

[RTCRtpHeaderExtensionParameters](classes/rtcrtpheaderextensionparameters.md)

#### Defined in

[packages/webrtc/src/extension/rtpExtension.ts:17](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/extension/rtpExtension.ts#L17)

___

### useTWCC

▸ `Const` **useTWCC**(): [RTCPFB](modules.md#rtcpfb)

#### Returns

[RTCPFB](modules.md#rtcpfb)

#### Defined in

[packages/webrtc/src/extension/rtcpFeedback.ts:11](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/extension/rtcpFeedback.ts#L11)

___

### useTransportWideCC

▸ **useTransportWideCC**(): [RTCRtpHeaderExtensionParameters](classes/rtcrtpheaderextensionparameters.md)

#### Returns

[RTCRtpHeaderExtensionParameters](classes/rtcrtpheaderextensionparameters.md)

#### Defined in

[packages/webrtc/src/extension/rtpExtension.ts:23](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/extension/rtpExtension.ts#L23)

---
id: "rtcpeerconnection"
title: "Class: RTCPeerConnection"
sidebar_label: "RTCPeerConnection"
custom_edit_url: null
hide_title: true
---

# Class: RTCPeerConnection

## Constructors

### constructor

\+ **new RTCPeerConnection**(`__namedParameters?`: *Partial*<[*PeerConfig*](../modules.md#peerconfig)\>): [*RTCPeerConnection*](rtcpeerconnection.md)

#### Parameters:

Name | Type | Default value |
:------ | :------ | :------ |
`__namedParameters` | *Partial*<[*PeerConfig*](../modules.md#peerconfig)\> | {} |

**Returns:** [*RTCPeerConnection*](rtcpeerconnection.md)

Defined in: [webrtc/src/peerConnection.ts:100](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L100)

## Properties

### certificates

• `Private` `Readonly` **certificates**: [*RTCCertificate*](rtccertificate.md)[]= []

Defined in: [webrtc/src/peerConnection.ts:91](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L91)

___

### cname

• `Readonly` **cname**: *string*

Defined in: [webrtc/src/peerConnection.ts:64](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L64)

___

### configuration

• **configuration**: *Required*<[*PeerConfig*](../modules.md#peerconfig)\>

Defined in: [webrtc/src/peerConnection.ts:69](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L69)

___

### connectionState

• **connectionState**: *new* \| *connecting* \| *connected* \| *closed* \| *failed* \| *disconnected*= "new"

Defined in: [webrtc/src/peerConnection.ts:72](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L72)

___

### connectionStateChange

• `Readonly` **connectionStateChange**: *default*<[*new* \| *connecting* \| *connected* \| *closed* \| *failed* \| *disconnected*]\>

Defined in: [webrtc/src/peerConnection.ts:81](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L81)

___

### currentLocalDescription

• `Private` `Optional` **currentLocalDescription**: *SessionDescription*

Defined in: [webrtc/src/peerConnection.ts:96](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L96)

___

### currentRemoteDescription

• `Private` `Optional` **currentRemoteDescription**: *SessionDescription*

Defined in: [webrtc/src/peerConnection.ts:97](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L97)

___

### dtlsTransport

• **dtlsTransport**: [*RTCDtlsTransport*](rtcdtlstransport.md)

Defined in: [webrtc/src/peerConnection.ts:66](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L66)

___

### iceConnectionState

• **iceConnectionState**: *new* \| *connected* \| *closed* \| *failed* \| *checking* \| *completed* \| *disconnected*= "new"

Defined in: [webrtc/src/peerConnection.ts:73](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L73)

___

### iceConnectionStateChange

• `Readonly` **iceConnectionStateChange**: *default*<[*new* \| *connected* \| *closed* \| *failed* \| *checking* \| *completed* \| *disconnected*]\>

Defined in: [webrtc/src/peerConnection.ts:79](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L79)

___

### iceGatheringState

• **iceGatheringState**: *new* \| *gathering* \| *complete*= "new"

Defined in: [webrtc/src/peerConnection.ts:74](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L74)

___

### iceGatheringStateChange

• `Readonly` **iceGatheringStateChange**: *default*<[*new* \| *gathering* \| *complete*]\>

Defined in: [webrtc/src/peerConnection.ts:78](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L78)

___

### iceTransport

• **iceTransport**: [*RTCIceTransport*](rtcicetransport.md)

Defined in: [webrtc/src/peerConnection.ts:65](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L65)

___

### isClosed

• `Private` **isClosed**: *boolean*= false

Defined in: [webrtc/src/peerConnection.ts:100](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L100)

___

### masterTransportEstablished

• **masterTransportEstablished**: *boolean*= false

Defined in: [webrtc/src/peerConnection.ts:68](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L68)

___

### negotiationneeded

• **negotiationneeded**: *boolean*= false

Defined in: [webrtc/src/peerConnection.ts:76](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L76)

___

### onDataChannel

• `Readonly` **onDataChannel**: *default*<[[*RTCDataChannel*](rtcdatachannel.md)]\>

Defined in: [webrtc/src/peerConnection.ts:82](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L82)

___

### onIceCandidate

• `Readonly` **onIceCandidate**: *default*<[*RTCIceCandidate*]\>

Defined in: [webrtc/src/peerConnection.ts:84](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L84)

___

### onTransceiver

• `Readonly` **onTransceiver**: *default*<[[*RTCRtpTransceiver*](rtcrtptransceiver.md)]\>

Defined in: [webrtc/src/peerConnection.ts:83](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L83)

___

### ondatachannel

• `Optional` **ondatachannel**: *null* \| (`event`: { `channel`: [*RTCDataChannel*](rtcdatachannel.md)  }) => *void*

Defined in: [webrtc/src/peerConnection.ts:86](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L86)

___

### onnegotiationneeded

• `Readonly` **onnegotiationneeded**: *default*<[]\>

Defined in: [webrtc/src/peerConnection.ts:85](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L85)

___

### pendingLocalDescription

• `Private` `Optional` **pendingLocalDescription**: *SessionDescription*

Defined in: [webrtc/src/peerConnection.ts:98](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L98)

___

### pendingRemoteDescription

• `Private` `Optional` **pendingRemoteDescription**: *SessionDescription*

Defined in: [webrtc/src/peerConnection.ts:99](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L99)

___

### remoteDtls

• `Private` `Optional` **remoteDtls**: *RTCDtlsParameters*

Defined in: [webrtc/src/peerConnection.ts:93](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L93)

___

### remoteIce

• `Private` `Optional` **remoteIce**: *RTCIceParameters*

Defined in: [webrtc/src/peerConnection.ts:94](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L94)

___

### router

• `Private` `Readonly` **router**: *RtpRouter*

Defined in: [webrtc/src/peerConnection.ts:90](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L90)

___

### sctpRemotePort

• `Private` `Optional` **sctpRemotePort**: *number*

Defined in: [webrtc/src/peerConnection.ts:92](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L92)

___

### sctpTransport

• `Optional` **sctpTransport**: [*RTCSctpTransport*](rtcsctptransport.md)

Defined in: [webrtc/src/peerConnection.ts:67](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L67)

___

### seenMid

• `Private` **seenMid**: *Set*<string\>

Defined in: [webrtc/src/peerConnection.ts:95](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L95)

___

### signalingState

• **signalingState**: *closed* \| *stable* \| *have-local-offer* \| *have-remote-offer* \| *have-local-pranswer* \| *have-remote-pranswer*= "stable"

Defined in: [webrtc/src/peerConnection.ts:75](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L75)

___

### signalingStateChange

• `Readonly` **signalingStateChange**: *default*<[*closed* \| *stable* \| *have-local-offer* \| *have-remote-offer* \| *have-local-pranswer* \| *have-remote-pranswer*]\>

Defined in: [webrtc/src/peerConnection.ts:80](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L80)

___

### transceivers

• `Readonly` **transceivers**: [*RTCRtpTransceiver*](rtcrtptransceiver.md)[]= []

Defined in: [webrtc/src/peerConnection.ts:77](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L77)

## Accessors

### \_localDescription

• `Private`get **_localDescription**(): *undefined* \| *SessionDescription*

**Returns:** *undefined* \| *SessionDescription*

Defined in: [webrtc/src/peerConnection.ts:164](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L164)

___

### \_remoteDescription

• `Private`get **_remoteDescription**(): *undefined* \| *SessionDescription*

**Returns:** *undefined* \| *SessionDescription*

Defined in: [webrtc/src/peerConnection.ts:168](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L168)

___

### localDescription

• get **localDescription**(): *undefined* \| [*RTCSessionDescription*](rtcsessiondescription.md)

**Returns:** *undefined* \| [*RTCSessionDescription*](rtcsessiondescription.md)

Defined in: [webrtc/src/peerConnection.ts:154](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L154)

___

### remoteDescription

• get **remoteDescription**(): *undefined* \| [*RTCSessionDescription*](rtcsessiondescription.md)

**Returns:** *undefined* \| [*RTCSessionDescription*](rtcsessiondescription.md)

Defined in: [webrtc/src/peerConnection.ts:159](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L159)

## Methods

### addIceCandidate

▸ **addIceCandidate**(`candidateMessage`: [*RTCIceCandidateJSON*](../modules.md#rtcicecandidatejson)): *Promise*<void\>

#### Parameters:

Name | Type |
:------ | :------ |
`candidateMessage` | [*RTCIceCandidateJSON*](../modules.md#rtcicecandidatejson) |

**Returns:** *Promise*<void\>

Defined in: [webrtc/src/peerConnection.ts:470](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L470)

___

### addTrack

▸ **addTrack**(`track`: [*MediaStreamTrack*](mediastreamtrack.md)): *RTCRtpSender*

#### Parameters:

Name | Type |
:------ | :------ |
`track` | [*MediaStreamTrack*](mediastreamtrack.md) |

**Returns:** *RTCRtpSender*

Defined in: [webrtc/src/peerConnection.ts:767](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L767)

___

### addTransceiver

▸ **addTransceiver**(`trackOrKind`: [*Kind*](../modules.md#kind) \| [*MediaStreamTrack*](mediastreamtrack.md), `options?`: *Partial*<[*TransceiverOptions*](../interfaces/transceiveroptions.md)\>): [*RTCRtpTransceiver*](rtcrtptransceiver.md)

#### Parameters:

Name | Type | Default value |
:------ | :------ | :------ |
`trackOrKind` | [*Kind*](../modules.md#kind) \| [*MediaStreamTrack*](mediastreamtrack.md) | - |
`options` | *Partial*<[*TransceiverOptions*](../interfaces/transceiveroptions.md)\> | {} |

**Returns:** [*RTCRtpTransceiver*](rtcrtptransceiver.md)

Defined in: [webrtc/src/peerConnection.ts:729](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L729)

___

### assertNotClosed

▸ `Private`**assertNotClosed**(): *void*

**Returns:** *void*

Defined in: [webrtc/src/peerConnection.ts:900](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L900)

___

### close

▸ **close**(): *Promise*<void\>

**Returns:** *Promise*<void\>

Defined in: [webrtc/src/peerConnection.ts:876](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L876)

___

### connect

▸ `Private`**connect**(): *Promise*<void\>

**Returns:** *Promise*<void\>

Defined in: [webrtc/src/peerConnection.ts:475](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L475)

___

### createAnswer

▸ **createAnswer**(): *Promise*<[*RTCSessionDescription*](rtcsessiondescription.md)\>

**Returns:** *Promise*<[*RTCSessionDescription*](rtcsessiondescription.md)\>

Defined in: [webrtc/src/peerConnection.ts:812](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L812)

___

### createDataChannel

▸ **createDataChannel**(`label`: *string*, `options?`: *Partial*<{ `id?`: *number* ; `maxPacketLifeTime?`: *number* ; `maxRetransmits?`: *number* ; `negotiated`: *boolean* ; `ordered`: *boolean* ; `protocol`: *string*  }\>): [*RTCDataChannel*](rtcdatachannel.md)

#### Parameters:

Name | Type | Default value |
:------ | :------ | :------ |
`label` | *string* | - |
`options` | *Partial*<{ `id?`: *number* ; `maxPacketLifeTime?`: *number* ; `maxRetransmits?`: *number* ; `negotiated`: *boolean* ; `ordered`: *boolean* ; `protocol`: *string*  }\> | {} |

**Returns:** [*RTCDataChannel*](rtcdatachannel.md)

Defined in: [webrtc/src/peerConnection.ts:275](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L275)

___

### createOffer

▸ **createOffer**(): *Promise*<[*RTCSessionDescription*](rtcsessiondescription.md)\>

**Returns:** *Promise*<[*RTCSessionDescription*](rtcsessiondescription.md)\>

Defined in: [webrtc/src/peerConnection.ts:182](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L182)

___

### createSctpTransport

▸ `Private`**createSctpTransport**(): [*RTCSctpTransport*](rtcsctptransport.md)

**Returns:** [*RTCSctpTransport*](rtcsctptransport.md)

Defined in: [webrtc/src/peerConnection.ts:380](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L380)

___

### createTransport

▸ `Private`**createTransport**(`srtpProfiles?`: *number*[]): *object*

#### Parameters:

Name | Type | Default value |
:------ | :------ | :------ |
`srtpProfiles` | *number*[] | [] |

**Returns:** *object*

Name | Type |
:------ | :------ |
`dtlsTransport` | [*RTCDtlsTransport*](rtcdtlstransport.md) |
`iceTransport` | [*RTCIceTransport*](rtcicetransport.md) |

Defined in: [webrtc/src/peerConnection.ts:346](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L346)

___

### getReceivers

▸ **getReceivers**(): *RTCRtpReceiver*[]

**Returns:** *RTCRtpReceiver*[]

Defined in: [webrtc/src/peerConnection.ts:763](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L763)

___

### getSenders

▸ **getSenders**(): *RTCRtpSender*[]

**Returns:** *RTCRtpSender*[]

Defined in: [webrtc/src/peerConnection.ts:759](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L759)

___

### getTransceiverByMLineIndex

▸ `Private`**getTransceiverByMLineIndex**(`index`: *number*): *undefined* \| [*RTCRtpTransceiver*](rtcrtptransceiver.md)

#### Parameters:

Name | Type |
:------ | :------ |
`index` | *number* |

**Returns:** *undefined* \| [*RTCRtpTransceiver*](rtcrtptransceiver.md)

Defined in: [webrtc/src/peerConnection.ts:176](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L176)

___

### getTransceiverByMid

▸ `Private`**getTransceiverByMid**(`mid`: *string*): *undefined* \| [*RTCRtpTransceiver*](rtcrtptransceiver.md)

#### Parameters:

Name | Type |
:------ | :------ |
`mid` | *string* |

**Returns:** *undefined* \| [*RTCRtpTransceiver*](rtcrtptransceiver.md)

Defined in: [webrtc/src/peerConnection.ts:172](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L172)

___

### getTransceivers

▸ **getTransceivers**(): [*RTCRtpTransceiver*](rtcrtptransceiver.md)[]

**Returns:** [*RTCRtpTransceiver*](rtcrtptransceiver.md)[]

Defined in: [webrtc/src/peerConnection.ts:755](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L755)

___

### localRtp

▸ `Private`**localRtp**(`transceiver`: [*RTCRtpTransceiver*](rtcrtptransceiver.md)): *RTCRtpParameters*

#### Parameters:

Name | Type |
:------ | :------ |
`transceiver` | [*RTCRtpTransceiver*](rtcrtptransceiver.md) |

**Returns:** *RTCRtpParameters*

Defined in: [webrtc/src/peerConnection.ts:501](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L501)

___

### needNegotiation

▸ `Private`**needNegotiation**(): *void*

**Returns:** *void*

Defined in: [webrtc/src/peerConnection.ts:341](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L341)

___

### remoteRtp

▸ `Private`**remoteRtp**(`transceiver`: [*RTCRtpTransceiver*](rtcrtptransceiver.md)): *RTCRtpReceiveParameters*

#### Parameters:

Name | Type |
:------ | :------ |
`transceiver` | [*RTCRtpTransceiver*](rtcrtptransceiver.md) |

**Returns:** *RTCRtpReceiveParameters*

Defined in: [webrtc/src/peerConnection.ts:509](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L509)

___

### removeAllListeners

▸ `Private`**removeAllListeners**(): *void*

**Returns:** *void*

Defined in: [webrtc/src/peerConnection.ts:928](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L928)

___

### removeTrack

▸ **removeTrack**(`sender`: *RTCRtpSender*): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`sender` | *RTCRtpSender* |

**Returns:** *void*

Defined in: [webrtc/src/peerConnection.ts:313](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L313)

___

### setConnectionState

▸ `Private`**setConnectionState**(`state`: *new* \| *connecting* \| *connected* \| *closed* \| *failed* \| *disconnected*): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`state` | *new* \| *connecting* \| *connected* \| *closed* \| *failed* \| *disconnected* |

**Returns:** *void*

Defined in: [webrtc/src/peerConnection.ts:922](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L922)

___

### setLocal

▸ `Private`**setLocal**(`description`: *SessionDescription*): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`description` | *SessionDescription* |

**Returns:** *void*

Defined in: [webrtc/src/peerConnection.ts:461](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L461)

___

### setLocalDescription

▸ **setLocalDescription**(`sessionDescription`: [*RTCSessionDescription*](rtcsessiondescription.md)): *Promise*<undefined \| [*RTCSessionDescription*](rtcsessiondescription.md)\>

#### Parameters:

Name | Type |
:------ | :------ |
`sessionDescription` | [*RTCSessionDescription*](rtcsessiondescription.md) |

**Returns:** *Promise*<undefined \| [*RTCSessionDescription*](rtcsessiondescription.md)\>

Defined in: [webrtc/src/peerConnection.ts:394](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L394)

___

### setRemoteDescription

▸ **setRemoteDescription**(`sessionDescription`: [*RTCSessionDescription*](rtcsessiondescription.md)): *Promise*<void\>

#### Parameters:

Name | Type |
:------ | :------ |
`sessionDescription` | [*RTCSessionDescription*](rtcsessiondescription.md) |

**Returns:** *Promise*<void\>

Defined in: [webrtc/src/peerConnection.ts:582](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L582)

___

### setSignalingState

▸ `Private`**setSignalingState**(`state`: *closed* \| *stable* \| *have-local-offer* \| *have-remote-offer* \| *have-local-pranswer* \| *have-remote-pranswer*): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`state` | *closed* \| *stable* \| *have-local-offer* \| *have-remote-offer* \| *have-local-pranswer* \| *have-remote-pranswer* |

**Returns:** *void*

Defined in: [webrtc/src/peerConnection.ts:916](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L916)

___

### updateIceConnectionState

▸ `Private`**updateIceConnectionState**(`state`: *new* \| *connected* \| *closed* \| *failed* \| *checking* \| *completed* \| *disconnected*): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`state` | *new* \| *connected* \| *closed* \| *failed* \| *checking* \| *completed* \| *disconnected* |

**Returns:** *void*

Defined in: [webrtc/src/peerConnection.ts:910](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L910)

___

### updateIceGatheringState

▸ `Private`**updateIceGatheringState**(`state`: *new* \| *gathering* \| *complete*): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`state` | *new* \| *gathering* \| *complete* |

**Returns:** *void*

Defined in: [webrtc/src/peerConnection.ts:904](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L904)

___

### validateDescription

▸ `Private`**validateDescription**(`description`: *SessionDescription*, `isLocal`: *boolean*): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`description` | *SessionDescription* |
`isLocal` | *boolean* |

**Returns:** *void*

Defined in: [webrtc/src/peerConnection.ts:528](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/peerConnection.ts#L528)

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

Name | Type |
:------ | :------ |
`__namedParameters` | *Partial*<[*PeerConfig*](../modules.md#peerconfig)\> |

**Returns:** [*RTCPeerConnection*](rtcpeerconnection.md)

Defined in: [webrtc/src/peerConnection.ts:83](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L83)

## Properties

### certificates

• `Private` `Readonly` **certificates**: [*RTCCertificate*](rtccertificate.md)[]

Defined in: [webrtc/src/peerConnection.ts:74](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L74)

___

### cname

• `Readonly` **cname**: *string*

Defined in: [webrtc/src/peerConnection.ts:55](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L55)

___

### configuration

• **configuration**: *Required*<[*PeerConfig*](../modules.md#peerconfig)\>

Defined in: [webrtc/src/peerConnection.ts:59](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L59)

___

### connectionState

• **connectionState**: *new* \| *connecting* \| *connected* \| *closed* \| *failed* \| *disconnected*= "new"

Defined in: [webrtc/src/peerConnection.ts:60](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L60)

___

### connectionStateChange

• `Readonly` **connectionStateChange**: *default*<[*new* \| *connecting* \| *connected* \| *closed* \| *failed* \| *disconnected*]\>

Defined in: [webrtc/src/peerConnection.ts:68](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L68)

___

### currentLocalDescription

• `Private` `Optional` **currentLocalDescription**: *SessionDescription*

Defined in: [webrtc/src/peerConnection.ts:79](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L79)

___

### currentRemoteDescription

• `Private` `Optional` **currentRemoteDescription**: *SessionDescription*

Defined in: [webrtc/src/peerConnection.ts:80](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L80)

___

### dtlsTransport

• `Optional` **dtlsTransport**: [*RTCDtlsTransport*](rtcdtlstransport.md)

Defined in: [webrtc/src/peerConnection.ts:56](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L56)

___

### iceConnectionState

• **iceConnectionState**: *new* \| *connected* \| *closed* \| *failed* \| *checking* \| *completed* \| *disconnected*= "new"

Defined in: [webrtc/src/peerConnection.ts:61](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L61)

___

### iceConnectionStateChange

• `Readonly` **iceConnectionStateChange**: *default*<[*new* \| *connected* \| *closed* \| *failed* \| *checking* \| *completed* \| *disconnected*]\>

Defined in: [webrtc/src/peerConnection.ts:66](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L66)

___

### iceGatheringState

• **iceGatheringState**: *new* \| *gathering* \| *complete*= "new"

Defined in: [webrtc/src/peerConnection.ts:62](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L62)

___

### iceGatheringStateChange

• `Readonly` **iceGatheringStateChange**: *default*<[*new* \| *gathering* \| *complete*]\>

Defined in: [webrtc/src/peerConnection.ts:65](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L65)

___

### isClosed

• `Private` **isClosed**: *boolean*= false

Defined in: [webrtc/src/peerConnection.ts:83](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L83)

___

### masterTransportEstablished

• **masterTransportEstablished**: *boolean*= false

Defined in: [webrtc/src/peerConnection.ts:58](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L58)

___

### onDataChannel

• `Readonly` **onDataChannel**: *default*<[[*RTCDataChannel*](rtcdatachannel.md)]\>

Defined in: [webrtc/src/peerConnection.ts:69](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L69)

___

### onIceCandidate

• `Readonly` **onIceCandidate**: *default*<[*RTCIceCandidate*]\>

Defined in: [webrtc/src/peerConnection.ts:71](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L71)

___

### onTransceiver

• `Readonly` **onTransceiver**: *default*<[[*RTCRtpTransceiver*](rtcrtptransceiver.md)]\>

Defined in: [webrtc/src/peerConnection.ts:70](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L70)

___

### pendingLocalDescription

• `Private` `Optional` **pendingLocalDescription**: *SessionDescription*

Defined in: [webrtc/src/peerConnection.ts:81](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L81)

___

### pendingRemoteDescription

• `Private` `Optional` **pendingRemoteDescription**: *SessionDescription*

Defined in: [webrtc/src/peerConnection.ts:82](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L82)

___

### remoteDtls

• `Private` `Optional` **remoteDtls**: *RTCDtlsParameters*

Defined in: [webrtc/src/peerConnection.ts:76](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L76)

___

### remoteIce

• `Private` `Optional` **remoteIce**: *RTCIceParameters*

Defined in: [webrtc/src/peerConnection.ts:77](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L77)

___

### router

• `Private` `Readonly` **router**: *RtpRouter*

Defined in: [webrtc/src/peerConnection.ts:73](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L73)

___

### sctpRemotePort

• `Private` `Optional` **sctpRemotePort**: *number*

Defined in: [webrtc/src/peerConnection.ts:75](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L75)

___

### sctpTransport

• `Optional` **sctpTransport**: [*RTCSctpTransport*](rtcsctptransport.md)

Defined in: [webrtc/src/peerConnection.ts:57](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L57)

___

### seenMid

• `Private` **seenMid**: *Set*<string\>

Defined in: [webrtc/src/peerConnection.ts:78](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L78)

___

### signalingState

• **signalingState**: *closed* \| *stable* \| *have-local-offer* \| *have-remote-offer* \| *have-local-pranswer* \| *have-remote-pranswer*= "stable"

Defined in: [webrtc/src/peerConnection.ts:63](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L63)

___

### signalingStateChange

• `Readonly` **signalingStateChange**: *default*<[*closed* \| *stable* \| *have-local-offer* \| *have-remote-offer* \| *have-local-pranswer* \| *have-remote-pranswer*]\>

Defined in: [webrtc/src/peerConnection.ts:67](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L67)

___

### transceivers

• `Readonly` **transceivers**: [*RTCRtpTransceiver*](rtcrtptransceiver.md)[]

Defined in: [webrtc/src/peerConnection.ts:64](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L64)

## Accessors

### \_localDescription

• `Private`get **_localDescription**(): *undefined* \| *SessionDescription*

**Returns:** *undefined* \| *SessionDescription*

Defined in: [webrtc/src/peerConnection.ts:138](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L138)

___

### \_remoteDescription

• `Private`get **_remoteDescription**(): *undefined* \| *SessionDescription*

**Returns:** *undefined* \| *SessionDescription*

Defined in: [webrtc/src/peerConnection.ts:142](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L142)

___

### localDescription

• get **localDescription**(): *undefined* \| [*RTCSessionDescription*](rtcsessiondescription.md)

**Returns:** *undefined* \| [*RTCSessionDescription*](rtcsessiondescription.md)

Defined in: [webrtc/src/peerConnection.ts:128](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L128)

___

### remoteDescription

• get **remoteDescription**(): *undefined* \| [*RTCSessionDescription*](rtcsessiondescription.md)

**Returns:** *undefined* \| [*RTCSessionDescription*](rtcsessiondescription.md)

Defined in: [webrtc/src/peerConnection.ts:133](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L133)

## Methods

### addIceCandidate

▸ **addIceCandidate**(`candidateMessage`: [*RTCIceCandidateJSON*](../modules.md#rtcicecandidatejson)): *Promise*<void\>

#### Parameters:

Name | Type |
:------ | :------ |
`candidateMessage` | [*RTCIceCandidateJSON*](../modules.md#rtcicecandidatejson) |

**Returns:** *Promise*<void\>

Defined in: [webrtc/src/peerConnection.ts:414](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L414)

___

### addTransceiver

▸ **addTransceiver**(`trackOrKind`: [*Kind*](../modules.md#kind) \| [*MediaStreamTrack*](mediastreamtrack.md), `direction`: *sendonly* \| *sendrecv* \| *recvonly* \| *inactive*, `options?`: *Partial*<[*TransceiverOptions*](../modules.md#transceiveroptions)\>): [*RTCRtpTransceiver*](rtcrtptransceiver.md)

#### Parameters:

Name | Type |
:------ | :------ |
`trackOrKind` | [*Kind*](../modules.md#kind) \| [*MediaStreamTrack*](mediastreamtrack.md) |
`direction` | *sendonly* \| *sendrecv* \| *recvonly* \| *inactive* |
`options` | *Partial*<[*TransceiverOptions*](../modules.md#transceiveroptions)\> |

**Returns:** [*RTCRtpTransceiver*](rtcrtptransceiver.md)

Defined in: [webrtc/src/peerConnection.ts:670](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L670)

___

### assertNotClosed

▸ `Private`**assertNotClosed**(): *void*

**Returns:** *void*

Defined in: [webrtc/src/peerConnection.ts:784](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L784)

___

### close

▸ **close**(): *Promise*<void\>

**Returns:** *Promise*<void\>

Defined in: [webrtc/src/peerConnection.ts:763](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L763)

___

### connect

▸ `Private`**connect**(): *Promise*<void\>

**Returns:** *Promise*<void\>

Defined in: [webrtc/src/peerConnection.ts:428](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L428)

___

### createAnswer

▸ **createAnswer**(): *Promise*<[*RTCSessionDescription*](rtcsessiondescription.md)\>

**Returns:** *Promise*<[*RTCSessionDescription*](rtcsessiondescription.md)\>

Defined in: [webrtc/src/peerConnection.ts:699](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L699)

___

### createDataChannel

▸ **createDataChannel**(`label`: *string*, `options?`: *Partial*<{ `id?`: *number* ; `maxPacketLifeTime?`: *number* ; `maxRetransmits?`: *number* ; `negotiated`: *boolean* ; `ordered`: *boolean* ; `protocol`: *string*  }\>): [*RTCDataChannel*](rtcdatachannel.md)

#### Parameters:

Name | Type |
:------ | :------ |
`label` | *string* |
`options` | *Partial*<{ `id?`: *number* ; `maxPacketLifeTime?`: *number* ; `maxRetransmits?`: *number* ; `negotiated`: *boolean* ; `ordered`: *boolean* ; `protocol`: *string*  }\> |

**Returns:** [*RTCDataChannel*](rtcdatachannel.md)

Defined in: [webrtc/src/peerConnection.ts:249](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L249)

___

### createDtlsTransport

▸ `Private`**createDtlsTransport**(`srtpProfiles?`: *number*[]): [*RTCDtlsTransport*](rtcdtlstransport.md)

#### Parameters:

Name | Type |
:------ | :------ |
`srtpProfiles` | *number*[] |

**Returns:** [*RTCDtlsTransport*](rtcdtlstransport.md)

Defined in: [webrtc/src/peerConnection.ts:301](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L301)

___

### createOffer

▸ **createOffer**(): *Promise*<[*RTCSessionDescription*](rtcsessiondescription.md)\>

**Returns:** *Promise*<[*RTCSessionDescription*](rtcsessiondescription.md)\>

Defined in: [webrtc/src/peerConnection.ts:156](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L156)

___

### createSctpTransport

▸ `Private`**createSctpTransport**(): [*RTCSctpTransport*](rtcsctptransport.md)

**Returns:** [*RTCSctpTransport*](rtcsctptransport.md)

Defined in: [webrtc/src/peerConnection.ts:335](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L335)

___

### gather

▸ `Private`**gather**(): *Promise*<void\>

**Returns:** *Promise*<void\>

Defined in: [webrtc/src/peerConnection.ts:423](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L423)

___

### getTransceiverByMLineIndex

▸ `Private`**getTransceiverByMLineIndex**(`index`: *number*): *undefined* \| [*RTCRtpTransceiver*](rtcrtptransceiver.md)

#### Parameters:

Name | Type |
:------ | :------ |
`index` | *number* |

**Returns:** *undefined* \| [*RTCRtpTransceiver*](rtcrtptransceiver.md)

Defined in: [webrtc/src/peerConnection.ts:150](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L150)

___

### getTransceiverByMid

▸ `Private`**getTransceiverByMid**(`mid`: *string*): *undefined* \| [*RTCRtpTransceiver*](rtcrtptransceiver.md)

#### Parameters:

Name | Type |
:------ | :------ |
`mid` | *string* |

**Returns:** *undefined* \| [*RTCRtpTransceiver*](rtcrtptransceiver.md)

Defined in: [webrtc/src/peerConnection.ts:146](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L146)

___

### localRtp

▸ `Private`**localRtp**(`transceiver`: [*RTCRtpTransceiver*](rtcrtptransceiver.md)): *RTCRtpParameters*

#### Parameters:

Name | Type |
:------ | :------ |
`transceiver` | [*RTCRtpTransceiver*](rtcrtptransceiver.md) |

**Returns:** *RTCRtpParameters*

Defined in: [webrtc/src/peerConnection.ts:451](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L451)

___

### remoteRtp

▸ `Private`**remoteRtp**(`transceiver`: [*RTCRtpTransceiver*](rtcrtptransceiver.md)): *RTCRtpReceiveParameters*

#### Parameters:

Name | Type |
:------ | :------ |
`transceiver` | [*RTCRtpTransceiver*](rtcrtptransceiver.md) |

**Returns:** *RTCRtpReceiveParameters*

Defined in: [webrtc/src/peerConnection.ts:459](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L459)

___

### removeAllListeners

▸ `Private`**removeAllListeners**(): *void*

**Returns:** *void*

Defined in: [webrtc/src/peerConnection.ts:812](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L812)

___

### removeTrack

▸ **removeTrack**(`transceiver`: [*RTCRtpTransceiver*](rtcrtptransceiver.md)): *void*

need createOffer

#### Parameters:

Name | Type |
:------ | :------ |
`transceiver` | [*RTCRtpTransceiver*](rtcrtptransceiver.md) |

**Returns:** *void*

Defined in: [webrtc/src/peerConnection.ts:290](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L290)

___

### setConnectionState

▸ `Private`**setConnectionState**(`state`: *new* \| *connecting* \| *connected* \| *closed* \| *failed* \| *disconnected*): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`state` | *new* \| *connecting* \| *connected* \| *closed* \| *failed* \| *disconnected* |

**Returns:** *void*

Defined in: [webrtc/src/peerConnection.ts:806](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L806)

___

### setLocal

▸ `Private`**setLocal**(`description`: *SessionDescription*): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`description` | *SessionDescription* |

**Returns:** *void*

Defined in: [webrtc/src/peerConnection.ts:405](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L405)

___

### setLocalDescription

▸ **setLocalDescription**(`sessionDescription`: [*RTCSessionDescription*](rtcsessiondescription.md)): *Promise*<undefined \| [*RTCSessionDescription*](rtcsessiondescription.md)\>

#### Parameters:

Name | Type |
:------ | :------ |
`sessionDescription` | [*RTCSessionDescription*](rtcsessiondescription.md) |

**Returns:** *Promise*<undefined \| [*RTCSessionDescription*](rtcsessiondescription.md)\>

Defined in: [webrtc/src/peerConnection.ts:348](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L348)

___

### setRemoteDescription

▸ **setRemoteDescription**(`sessionDescription`: [*RTCSessionDescription*](rtcsessiondescription.md)): *Promise*<void\>

#### Parameters:

Name | Type |
:------ | :------ |
`sessionDescription` | [*RTCSessionDescription*](rtcsessiondescription.md) |

**Returns:** *Promise*<void\>

Defined in: [webrtc/src/peerConnection.ts:532](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L532)

___

### setSignalingState

▸ `Private`**setSignalingState**(`state`: *closed* \| *stable* \| *have-local-offer* \| *have-remote-offer* \| *have-local-pranswer* \| *have-remote-pranswer*): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`state` | *closed* \| *stable* \| *have-local-offer* \| *have-remote-offer* \| *have-local-pranswer* \| *have-remote-pranswer* |

**Returns:** *void*

Defined in: [webrtc/src/peerConnection.ts:800](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L800)

___

### updateIceConnectionState

▸ `Private`**updateIceConnectionState**(`state`: *new* \| *connected* \| *closed* \| *failed* \| *checking* \| *completed* \| *disconnected*): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`state` | *new* \| *connected* \| *closed* \| *failed* \| *checking* \| *completed* \| *disconnected* |

**Returns:** *void*

Defined in: [webrtc/src/peerConnection.ts:794](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L794)

___

### updateIceGatheringState

▸ `Private`**updateIceGatheringState**(`state`: *new* \| *gathering* \| *complete*): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`state` | *new* \| *gathering* \| *complete* |

**Returns:** *void*

Defined in: [webrtc/src/peerConnection.ts:788](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L788)

___

### validateDescription

▸ `Private`**validateDescription**(`description`: *SessionDescription*, `isLocal`: *boolean*): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`description` | *SessionDescription* |
`isLocal` | *boolean* |

**Returns:** *void*

Defined in: [webrtc/src/peerConnection.ts:478](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/peerConnection.ts#L478)

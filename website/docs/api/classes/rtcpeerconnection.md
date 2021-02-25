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

Defined in: [webrtc/src/peerConnection.ts:82](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L82)

## Properties

### certificates

• `Private` **certificates**: [*RTCCertificate*](rtccertificate.md)[]

Defined in: [webrtc/src/peerConnection.ts:73](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L73)

___

### cname

• `Readonly` **cname**: *string*

Defined in: [webrtc/src/peerConnection.ts:54](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L54)

___

### configuration

• **configuration**: *Required*<[*PeerConfig*](../modules.md#peerconfig)\>

Defined in: [webrtc/src/peerConnection.ts:58](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L58)

___

### connectionState

• **connectionState**: *closed* \| *connecting* \| *failed* \| *disconnected* \| *new* \| *connected*= "new"

Defined in: [webrtc/src/peerConnection.ts:59](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L59)

___

### connectionStateChange

• `Readonly` **connectionStateChange**: *default*<[*closed* \| *connecting* \| *failed* \| *disconnected* \| *new* \| *connected*]\>

Defined in: [webrtc/src/peerConnection.ts:67](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L67)

___

### currentLocalDescription

• `Private` `Optional` **currentLocalDescription**: *undefined* \| *SessionDescription*

Defined in: [webrtc/src/peerConnection.ts:78](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L78)

___

### currentRemoteDescription

• `Private` `Optional` **currentRemoteDescription**: *undefined* \| *SessionDescription*

Defined in: [webrtc/src/peerConnection.ts:79](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L79)

___

### iceConnectionState

• **iceConnectionState**: *closed* \| *failed* \| *disconnected* \| *new* \| *connected* \| *checking* \| *completed*= "new"

Defined in: [webrtc/src/peerConnection.ts:60](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L60)

___

### iceConnectionStateChange

• `Readonly` **iceConnectionStateChange**: *default*<[*closed* \| *failed* \| *disconnected* \| *new* \| *connected* \| *checking* \| *completed*]\>

Defined in: [webrtc/src/peerConnection.ts:65](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L65)

___

### iceGatheringState

• **iceGatheringState**: *new* \| *gathering* \| *complete*= "new"

Defined in: [webrtc/src/peerConnection.ts:61](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L61)

___

### iceGatheringStateChange

• `Readonly` **iceGatheringStateChange**: *default*<[*new* \| *gathering* \| *complete*]\>

Defined in: [webrtc/src/peerConnection.ts:64](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L64)

___

### isClosed

• `Private` **isClosed**: *boolean*= false

Defined in: [webrtc/src/peerConnection.ts:82](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L82)

___

### masterTransport

• `Optional` **masterTransport**: *undefined* \| *RTCDtlsTransport*

Defined in: [webrtc/src/peerConnection.ts:55](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L55)

___

### masterTransportEstablished

• **masterTransportEstablished**: *boolean*= false

Defined in: [webrtc/src/peerConnection.ts:57](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L57)

___

### onDataChannel

• `Readonly` **onDataChannel**: *default*<[[*RTCDataChannel*](rtcdatachannel.md)]\>

Defined in: [webrtc/src/peerConnection.ts:68](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L68)

___

### onIceCandidate

• `Readonly` **onIceCandidate**: *default*<[*RTCIceCandidate*]\>

Defined in: [webrtc/src/peerConnection.ts:70](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L70)

___

### onTransceiver

• `Readonly` **onTransceiver**: *default*<[[*RTCRtpTransceiver*](rtcrtptransceiver.md)]\>

Defined in: [webrtc/src/peerConnection.ts:69](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L69)

___

### pendingLocalDescription

• `Private` `Optional` **pendingLocalDescription**: *undefined* \| *SessionDescription*

Defined in: [webrtc/src/peerConnection.ts:80](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L80)

___

### pendingRemoteDescription

• `Private` `Optional` **pendingRemoteDescription**: *undefined* \| *SessionDescription*

Defined in: [webrtc/src/peerConnection.ts:81](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L81)

___

### remoteDtls

• `Private` `Optional` **remoteDtls**: *undefined* \| *RTCDtlsParameters*

Defined in: [webrtc/src/peerConnection.ts:75](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L75)

___

### remoteIce

• `Private` `Optional` **remoteIce**: *undefined* \| *RTCIceParameters*

Defined in: [webrtc/src/peerConnection.ts:76](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L76)

___

### router

• `Private` `Readonly` **router**: *RtpRouter*

Defined in: [webrtc/src/peerConnection.ts:72](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L72)

___

### sctpRemotePort

• `Private` `Optional` **sctpRemotePort**: *undefined* \| *number*

Defined in: [webrtc/src/peerConnection.ts:74](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L74)

___

### sctpTransport

• `Optional` **sctpTransport**: *undefined* \| [*RTCSctpTransport*](rtcsctptransport.md)

Defined in: [webrtc/src/peerConnection.ts:56](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L56)

___

### seenMid

• `Private` **seenMid**: *Set*<string\>

Defined in: [webrtc/src/peerConnection.ts:77](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L77)

___

### signalingState

• **signalingState**: *closed* \| *stable* \| *have-local-offer* \| *have-remote-offer* \| *have-local-pranswer* \| *have-remote-pranswer*= "stable"

Defined in: [webrtc/src/peerConnection.ts:62](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L62)

___

### signalingStateChange

• `Readonly` **signalingStateChange**: *default*<[*closed* \| *stable* \| *have-local-offer* \| *have-remote-offer* \| *have-local-pranswer* \| *have-remote-pranswer*]\>

Defined in: [webrtc/src/peerConnection.ts:66](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L66)

___

### transceivers

• `Readonly` **transceivers**: [*RTCRtpTransceiver*](rtcrtptransceiver.md)[]

Defined in: [webrtc/src/peerConnection.ts:63](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L63)

## Accessors

### \_localDescription

• `Private`get **_localDescription**(): *undefined* \| *SessionDescription*

**Returns:** *undefined* \| *SessionDescription*

Defined in: [webrtc/src/peerConnection.ts:141](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L141)

___

### \_remoteDescription

• `Private`get **_remoteDescription**(): *undefined* \| *SessionDescription*

**Returns:** *undefined* \| *SessionDescription*

Defined in: [webrtc/src/peerConnection.ts:145](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L145)

___

### localDescription

• get **localDescription**(): *undefined* \| [*RTCSessionDescription*](rtcsessiondescription.md)

**Returns:** *undefined* \| [*RTCSessionDescription*](rtcsessiondescription.md)

Defined in: [webrtc/src/peerConnection.ts:131](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L131)

___

### remoteDescription

• get **remoteDescription**(): *undefined* \| [*RTCSessionDescription*](rtcsessiondescription.md)

**Returns:** *undefined* \| [*RTCSessionDescription*](rtcsessiondescription.md)

Defined in: [webrtc/src/peerConnection.ts:136](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L136)

## Methods

### addIceCandidate

▸ **addIceCandidate**(`candidateMessage`: [*RTCIceCandidateJSON*](../modules.md#rtcicecandidatejson)): *Promise*<void\>

#### Parameters:

Name | Type |
:------ | :------ |
`candidateMessage` | [*RTCIceCandidateJSON*](../modules.md#rtcicecandidatejson) |

**Returns:** *Promise*<void\>

Defined in: [webrtc/src/peerConnection.ts:403](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L403)

___

### addTransceiver

▸ **addTransceiver**(`kind`: [*Kind*](../modules.md#kind), `direction`: *sendonly* \| *sendrecv* \| *recvonly* \| *inactive*, `options?`: *Partial*<[*TransceiverOptions*](../modules.md#transceiveroptions)\>): [*RTCRtpTransceiver*](rtcrtptransceiver.md)

#### Parameters:

Name | Type |
:------ | :------ |
`kind` | [*Kind*](../modules.md#kind) |
`direction` | *sendonly* \| *sendrecv* \| *recvonly* \| *inactive* |
`options` | *Partial*<[*TransceiverOptions*](../modules.md#transceiveroptions)\> |

**Returns:** [*RTCRtpTransceiver*](rtcrtptransceiver.md)

Defined in: [webrtc/src/peerConnection.ts:653](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L653)

___

### assertNotClosed

▸ `Private`**assertNotClosed**(): *void*

**Returns:** *void*

Defined in: [webrtc/src/peerConnection.ts:759](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L759)

___

### close

▸ **close**(): *Promise*<void\>

**Returns:** *Promise*<void\>

Defined in: [webrtc/src/peerConnection.ts:738](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L738)

___

### connect

▸ `Private`**connect**(): *Promise*<void\>

**Returns:** *Promise*<void\>

Defined in: [webrtc/src/peerConnection.ts:417](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L417)

___

### createAnswer

▸ **createAnswer**(): [*RTCSessionDescription*](rtcsessiondescription.md)

**Returns:** [*RTCSessionDescription*](rtcsessiondescription.md)

Defined in: [webrtc/src/peerConnection.ts:679](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L679)

___

### createDataChannel

▸ **createDataChannel**(`label`: *string*, `options?`: *Partial*<{ `id?`: *undefined* \| *number* ; `maxPacketLifeTime?`: *undefined* \| *number* ; `maxRetransmits?`: *undefined* \| *number* ; `negotiated`: *boolean* ; `ordered`: *boolean* ; `protocol`: *string*  }\>): [*RTCDataChannel*](rtcdatachannel.md)

#### Parameters:

Name | Type |
:------ | :------ |
`label` | *string* |
`options` | *Partial*<{ `id?`: *undefined* \| *number* ; `maxPacketLifeTime?`: *undefined* \| *number* ; `maxRetransmits?`: *undefined* \| *number* ; `negotiated`: *boolean* ; `ordered`: *boolean* ; `protocol`: *string*  }\> |

**Returns:** [*RTCDataChannel*](rtcdatachannel.md)

Defined in: [webrtc/src/peerConnection.ts:245](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L245)

___

### createDtlsTransport

▸ `Private`**createDtlsTransport**(`srtpProfiles?`: *number*[]): *RTCDtlsTransport*

#### Parameters:

Name | Type |
:------ | :------ |
`srtpProfiles` | *number*[] |

**Returns:** *RTCDtlsTransport*

Defined in: [webrtc/src/peerConnection.ts:297](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L297)

___

### createOffer

▸ **createOffer**(): [*RTCSessionDescription*](rtcsessiondescription.md)

**Returns:** [*RTCSessionDescription*](rtcsessiondescription.md)

Defined in: [webrtc/src/peerConnection.ts:159](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L159)

___

### createSctpTransport

▸ `Private`**createSctpTransport**(): [*RTCSctpTransport*](rtcsctptransport.md)

**Returns:** [*RTCSctpTransport*](rtcsctptransport.md)

Defined in: [webrtc/src/peerConnection.ts:331](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L331)

___

### gather

▸ `Private`**gather**(): *Promise*<void\>

**Returns:** *Promise*<void\>

Defined in: [webrtc/src/peerConnection.ts:412](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L412)

___

### getTransceiverByMLineIndex

▸ `Private`**getTransceiverByMLineIndex**(`index`: *number*): *undefined* \| [*RTCRtpTransceiver*](rtcrtptransceiver.md)

#### Parameters:

Name | Type |
:------ | :------ |
`index` | *number* |

**Returns:** *undefined* \| [*RTCRtpTransceiver*](rtcrtptransceiver.md)

Defined in: [webrtc/src/peerConnection.ts:153](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L153)

___

### getTransceiverByMid

▸ `Private`**getTransceiverByMid**(`mid`: *string*): *undefined* \| [*RTCRtpTransceiver*](rtcrtptransceiver.md)

#### Parameters:

Name | Type |
:------ | :------ |
`mid` | *string* |

**Returns:** *undefined* \| [*RTCRtpTransceiver*](rtcrtptransceiver.md)

Defined in: [webrtc/src/peerConnection.ts:149](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L149)

___

### localRtp

▸ `Private`**localRtp**(`transceiver`: [*RTCRtpTransceiver*](rtcrtptransceiver.md)): *RTCRtpParameters*

#### Parameters:

Name | Type |
:------ | :------ |
`transceiver` | [*RTCRtpTransceiver*](rtcrtptransceiver.md) |

**Returns:** *RTCRtpParameters*

Defined in: [webrtc/src/peerConnection.ts:440](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L440)

___

### remoteRtp

▸ `Private`**remoteRtp**(`transceiver`: [*RTCRtpTransceiver*](rtcrtptransceiver.md)): *RTCRtpReceiveParameters*

#### Parameters:

Name | Type |
:------ | :------ |
`transceiver` | [*RTCRtpTransceiver*](rtcrtptransceiver.md) |

**Returns:** *RTCRtpReceiveParameters*

Defined in: [webrtc/src/peerConnection.ts:448](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L448)

___

### removeAllListeners

▸ `Private`**removeAllListeners**(): *void*

**Returns:** *void*

Defined in: [webrtc/src/peerConnection.ts:787](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L787)

___

### removeTrack

▸ **removeTrack**(`transceiver`: [*RTCRtpTransceiver*](rtcrtptransceiver.md)): *void*

need createOffer

#### Parameters:

Name | Type |
:------ | :------ |
`transceiver` | [*RTCRtpTransceiver*](rtcrtptransceiver.md) |

**Returns:** *void*

Defined in: [webrtc/src/peerConnection.ts:286](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L286)

___

### setConnectionState

▸ `Private`**setConnectionState**(`state`: *closed* \| *connecting* \| *failed* \| *disconnected* \| *new* \| *connected*): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`state` | *closed* \| *connecting* \| *failed* \| *disconnected* \| *new* \| *connected* |

**Returns:** *void*

Defined in: [webrtc/src/peerConnection.ts:781](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L781)

___

### setLocal

▸ `Private`**setLocal**(`description`: *SessionDescription*): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`description` | *SessionDescription* |

**Returns:** *void*

Defined in: [webrtc/src/peerConnection.ts:394](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L394)

___

### setLocalDescription

▸ **setLocalDescription**(`sessionDescription`: [*RTCSessionDescription*](rtcsessiondescription.md)): *Promise*<undefined \| [*RTCSessionDescription*](rtcsessiondescription.md)\>

#### Parameters:

Name | Type |
:------ | :------ |
`sessionDescription` | [*RTCSessionDescription*](rtcsessiondescription.md) |

**Returns:** *Promise*<undefined \| [*RTCSessionDescription*](rtcsessiondescription.md)\>

Defined in: [webrtc/src/peerConnection.ts:344](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L344)

___

### setRemoteDescription

▸ **setRemoteDescription**(`sessionDescription`: [*RTCSessionDescription*](rtcsessiondescription.md)): *Promise*<void\>

#### Parameters:

Name | Type |
:------ | :------ |
`sessionDescription` | [*RTCSessionDescription*](rtcsessiondescription.md) |

**Returns:** *Promise*<void\>

Defined in: [webrtc/src/peerConnection.ts:521](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L521)

___

### setSignalingState

▸ `Private`**setSignalingState**(`state`: *closed* \| *stable* \| *have-local-offer* \| *have-remote-offer* \| *have-local-pranswer* \| *have-remote-pranswer*): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`state` | *closed* \| *stable* \| *have-local-offer* \| *have-remote-offer* \| *have-local-pranswer* \| *have-remote-pranswer* |

**Returns:** *void*

Defined in: [webrtc/src/peerConnection.ts:775](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L775)

___

### updateIceConnectionState

▸ `Private`**updateIceConnectionState**(`state`: *closed* \| *failed* \| *disconnected* \| *new* \| *connected* \| *checking* \| *completed*): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`state` | *closed* \| *failed* \| *disconnected* \| *new* \| *connected* \| *checking* \| *completed* |

**Returns:** *void*

Defined in: [webrtc/src/peerConnection.ts:769](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L769)

___

### updateIceGatheringState

▸ `Private`**updateIceGatheringState**(`state`: *new* \| *gathering* \| *complete*): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`state` | *new* \| *gathering* \| *complete* |

**Returns:** *void*

Defined in: [webrtc/src/peerConnection.ts:763](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L763)

___

### validateDescription

▸ `Private`**validateDescription**(`description`: *SessionDescription*, `isLocal`: *boolean*): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`description` | *SessionDescription* |
`isLocal` | *boolean* |

**Returns:** *void*

Defined in: [webrtc/src/peerConnection.ts:467](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/peerConnection.ts#L467)

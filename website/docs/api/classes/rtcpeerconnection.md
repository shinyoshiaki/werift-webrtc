---
id: "rtcpeerconnection"
title: "Class: RTCPeerConnection"
sidebar_label: "RTCPeerConnection"
sidebar_position: 0
custom_edit_url: null
---

## Hierarchy

- [EventTarget](eventtarget.md)

  ↳ **RTCPeerConnection**

## Constructors

### constructor

• **new RTCPeerConnection**(`__namedParameters?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `__namedParameters` | `Partial`<[PeerConfig](../interfaces/peerconfig.md)\> |

#### Overrides

[EventTarget](eventtarget.md).[constructor](eventtarget.md#constructor)

#### Defined in

[packages/webrtc/src/peerConnection.ts:111](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L111)

## Properties

### certificates

• `Private` `Readonly` **certificates**: [RTCCertificate](rtccertificate.md)[] = []

#### Defined in

[packages/webrtc/src/peerConnection.ts:101](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L101)

___

### cname

• `Readonly` **cname**: `string`

#### Defined in

[packages/webrtc/src/peerConnection.ts:65](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L65)

___

### configuration

• **configuration**: `Required`<[PeerConfig](../interfaces/peerconfig.md)\>

#### Defined in

[packages/webrtc/src/peerConnection.ts:70](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L70)

___

### connectionState

• **connectionState**: ``"closed"`` \| ``"connecting"`` \| ``"failed"`` \| ``"disconnected"`` \| ``"new"`` \| ``"connected"`` = "new"

#### Defined in

[packages/webrtc/src/peerConnection.ts:72](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L72)

___

### connectionStateChange

• `Readonly` **connectionStateChange**: `default`<[``"closed"`` \| ``"connecting"`` \| ``"failed"`` \| ``"disconnected"`` \| ``"new"`` \| ``"connected"``]\>

#### Defined in

[packages/webrtc/src/peerConnection.ts:81](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L81)

___

### currentLocalDescription

• `Private` `Optional` **currentLocalDescription**: [SessionDescription](sessiondescription.md)

#### Defined in

[packages/webrtc/src/peerConnection.ts:106](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L106)

___

### currentRemoteDescription

• `Private` `Optional` **currentRemoteDescription**: [SessionDescription](sessiondescription.md)

#### Defined in

[packages/webrtc/src/peerConnection.ts:107](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L107)

___

### dtlsTransport

• **dtlsTransport**: [RTCDtlsTransport](rtcdtlstransport.md)

#### Defined in

[packages/webrtc/src/peerConnection.ts:67](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L67)

___

### iceConnectionState

• **iceConnectionState**: ``"closed"`` \| ``"failed"`` \| ``"disconnected"`` \| ``"new"`` \| ``"connected"`` \| ``"checking"`` \| ``"completed"`` = "new"

#### Defined in

[packages/webrtc/src/peerConnection.ts:73](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L73)

___

### iceConnectionStateChange

• `Readonly` **iceConnectionStateChange**: `default`<[``"closed"`` \| ``"failed"`` \| ``"disconnected"`` \| ``"new"`` \| ``"connected"`` \| ``"checking"`` \| ``"completed"``]\>

#### Defined in

[packages/webrtc/src/peerConnection.ts:79](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L79)

___

### iceGatheringState

• **iceGatheringState**: ``"new"`` \| ``"gathering"`` \| ``"complete"`` = "new"

#### Defined in

[packages/webrtc/src/peerConnection.ts:74](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L74)

___

### iceGatheringStateChange

• `Readonly` **iceGatheringStateChange**: `default`<[``"new"`` \| ``"gathering"`` \| ``"complete"``]\>

#### Defined in

[packages/webrtc/src/peerConnection.ts:78](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L78)

___

### iceTransport

• **iceTransport**: [RTCIceTransport](rtcicetransport.md)

#### Defined in

[packages/webrtc/src/peerConnection.ts:66](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L66)

___

### isClosed

• `Private` **isClosed**: `boolean` = false

#### Defined in

[packages/webrtc/src/peerConnection.ts:110](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L110)

___

### masterTransportEstablished

• **masterTransportEstablished**: `boolean` = false

#### Defined in

[packages/webrtc/src/peerConnection.ts:69](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L69)

___

### negotiationneeded

• **negotiationneeded**: `boolean` = false

#### Defined in

[packages/webrtc/src/peerConnection.ts:76](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L76)

___

### onDataChannel

• `Readonly` **onDataChannel**: `default`<[[RTCDataChannel](rtcdatachannel.md)]\>

#### Defined in

[packages/webrtc/src/peerConnection.ts:82](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L82)

___

### onIceCandidate

• `Readonly` **onIceCandidate**: `default`<[[RTCIceCandidate](../modules.md#rtcicecandidate)]\>

#### Defined in

[packages/webrtc/src/peerConnection.ts:90](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L90)

___

### onNegotiationneeded

• `Readonly` **onNegotiationneeded**: `default`<[]\>

#### Defined in

[packages/webrtc/src/peerConnection.ts:91](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L91)

___

### onRemoteTransceiverAdded

• `Readonly` **onRemoteTransceiverAdded**: `default`<[[RTCRtpTransceiver](rtcrtptransceiver.md)]\>

#### Defined in

[packages/webrtc/src/peerConnection.ts:83](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L83)

___

### onTransceiver

• `Readonly` **onTransceiver**: `default`<[[RTCRtpTransceiver](rtcrtptransceiver.md)]\>

should use onRemoteTransceiverAdded

**`deprecated`**

#### Defined in

[packages/webrtc/src/peerConnection.ts:88](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L88)

___

### onTransceiverAdded

• `Readonly` **onTransceiverAdded**: `default`<[[RTCRtpTransceiver](rtcrtptransceiver.md)]\>

#### Defined in

[packages/webrtc/src/peerConnection.ts:89](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L89)

___

### onconnectionstatechange

• `Optional` **onconnectionstatechange**: `Callback`

#### Defined in

[packages/webrtc/src/peerConnection.ts:98](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L98)

___

### ondatachannel

• `Optional` **ondatachannel**: `CallbackWithValue`<[RTCDataChannelEvent](../interfaces/rtcdatachannelevent.md)\>

#### Defined in

[packages/webrtc/src/peerConnection.ts:93](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L93)

___

### onicecandidate

• `Optional` **onicecandidate**: `CallbackWithValue`<[RTCPeerConnectionIceEvent](../interfaces/rtcpeerconnectioniceevent.md)\>

#### Defined in

[packages/webrtc/src/peerConnection.ts:94](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L94)

___

### onnegotiationneeded

• `Optional` **onnegotiationneeded**: `CallbackWithValue`<any\>

#### Defined in

[packages/webrtc/src/peerConnection.ts:95](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L95)

___

### onsignalingstatechange

• `Optional` **onsignalingstatechange**: `CallbackWithValue`<any\>

#### Defined in

[packages/webrtc/src/peerConnection.ts:96](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L96)

___

### ontrack

• `Optional` **ontrack**: `CallbackWithValue`<[RTCTrackEvent](../interfaces/rtctrackevent.md)\>

#### Defined in

[packages/webrtc/src/peerConnection.ts:97](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L97)

___

### pendingLocalDescription

• `Private` `Optional` **pendingLocalDescription**: [SessionDescription](sessiondescription.md)

#### Defined in

[packages/webrtc/src/peerConnection.ts:108](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L108)

___

### pendingRemoteDescription

• `Private` `Optional` **pendingRemoteDescription**: [SessionDescription](sessiondescription.md)

#### Defined in

[packages/webrtc/src/peerConnection.ts:109](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L109)

___

### remoteDtls

• `Private` `Optional` **remoteDtls**: [RTCDtlsParameters](rtcdtlsparameters.md)

#### Defined in

[packages/webrtc/src/peerConnection.ts:103](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L103)

___

### remoteIce

• `Private` `Optional` **remoteIce**: [RTCIceParameters](rtciceparameters.md)

#### Defined in

[packages/webrtc/src/peerConnection.ts:104](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L104)

___

### router

• `Private` `Readonly` **router**: `RtpRouter`

#### Defined in

[packages/webrtc/src/peerConnection.ts:100](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L100)

___

### sctpRemotePort

• `Private` `Optional` **sctpRemotePort**: `number`

#### Defined in

[packages/webrtc/src/peerConnection.ts:102](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L102)

___

### sctpTransport

• `Optional` **sctpTransport**: [RTCSctpTransport](rtcsctptransport.md)

#### Defined in

[packages/webrtc/src/peerConnection.ts:68](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L68)

___

### seenMid

• `Private` **seenMid**: `Set`<string\>

#### Defined in

[packages/webrtc/src/peerConnection.ts:105](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L105)

___

### shouldNegotiationneeded

• `Private` **shouldNegotiationneeded**: `boolean` = false

#### Defined in

[packages/webrtc/src/peerConnection.ts:111](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L111)

___

### signalingState

• **signalingState**: ``"closed"`` \| ``"stable"`` \| ``"have-local-offer"`` \| ``"have-remote-offer"`` \| ``"have-local-pranswer"`` \| ``"have-remote-pranswer"`` = "stable"

#### Defined in

[packages/webrtc/src/peerConnection.ts:75](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L75)

___

### signalingStateChange

• `Readonly` **signalingStateChange**: `default`<[``"closed"`` \| ``"stable"`` \| ``"have-local-offer"`` \| ``"have-remote-offer"`` \| ``"have-local-pranswer"`` \| ``"have-remote-pranswer"``]\>

#### Defined in

[packages/webrtc/src/peerConnection.ts:80](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L80)

___

### transceivers

• `Readonly` **transceivers**: [RTCRtpTransceiver](rtcrtptransceiver.md)[] = []

#### Defined in

[packages/webrtc/src/peerConnection.ts:77](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L77)

___

### captureRejectionSymbol

▪ `Static` `Readonly` **captureRejectionSymbol**: typeof [captureRejectionSymbol](rtcdatachannel.md#capturerejectionsymbol)

#### Inherited from

[EventTarget](eventtarget.md).[captureRejectionSymbol](eventtarget.md#capturerejectionsymbol)

#### Defined in

node_modules/@types/node/events.d.ts:46

___

### captureRejections

▪ `Static` **captureRejections**: `boolean`

Sets or gets the default captureRejection value for all emitters.

#### Inherited from

[EventTarget](eventtarget.md).[captureRejections](eventtarget.md#capturerejections)

#### Defined in

node_modules/@types/node/events.d.ts:52

___

### defaultMaxListeners

▪ `Static` **defaultMaxListeners**: `number`

#### Inherited from

[EventTarget](eventtarget.md).[defaultMaxListeners](eventtarget.md#defaultmaxlisteners)

#### Defined in

node_modules/@types/node/events.d.ts:53

___

### errorMonitor

▪ `Static` `Readonly` **errorMonitor**: typeof [errorMonitor](rtcdatachannel.md#errormonitor)

This symbol shall be used to install a listener for only monitoring `'error'`
events. Listeners installed using this symbol are called before the regular
`'error'` listeners are called.

Installing a listener using this symbol does not change the behavior once an
`'error'` event is emitted, therefore the process will still crash if no
regular `'error'` listener is installed.

#### Inherited from

[EventTarget](eventtarget.md).[errorMonitor](eventtarget.md#errormonitor)

#### Defined in

node_modules/@types/node/events.d.ts:45

## Accessors

### \_localDescription

• `Private` `get` **_localDescription**(): `undefined` \| [SessionDescription](sessiondescription.md)

#### Returns

`undefined` \| [SessionDescription](sessiondescription.md)

#### Defined in

[packages/webrtc/src/peerConnection.ts:179](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L179)

___

### \_remoteDescription

• `Private` `get` **_remoteDescription**(): `undefined` \| [SessionDescription](sessiondescription.md)

#### Returns

`undefined` \| [SessionDescription](sessiondescription.md)

#### Defined in

[packages/webrtc/src/peerConnection.ts:183](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L183)

___

### localDescription

• `get` **localDescription**(): `undefined` \| [RTCSessionDescription](rtcsessiondescription.md)

#### Returns

`undefined` \| [RTCSessionDescription](rtcsessiondescription.md)

#### Defined in

[packages/webrtc/src/peerConnection.ts:169](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L169)

___

### remoteDescription

• `get` **remoteDescription**(): `undefined` \| [RTCSessionDescription](rtcsessiondescription.md)

#### Returns

`undefined` \| [RTCSessionDescription](rtcsessiondescription.md)

#### Defined in

[packages/webrtc/src/peerConnection.ts:174](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L174)

## Methods

### addEventListener

▸ **addEventListener**(`type`, `listener`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `type` | `string` |
| `listener` | (...`args`: `any`[]) => `void` |

#### Returns

`void`

#### Inherited from

[EventTarget](eventtarget.md).[addEventListener](eventtarget.md#addeventlistener)

#### Defined in

[packages/webrtc/src/helper.ts:37](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/helper.ts#L37)

___

### addIceCandidate

▸ **addIceCandidate**(`candidateMessage`): `Promise`<void\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `candidateMessage` | [RTCIceCandidate](../modules.md#rtcicecandidate) |

#### Returns

`Promise`<void\>

#### Defined in

[packages/webrtc/src/peerConnection.ts:517](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L517)

___

### addListener

▸ **addListener**(`event`, `listener`): [RTCPeerConnection](rtcpeerconnection.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `event` | `string` \| `symbol` |
| `listener` | (...`args`: `any`[]) => `void` |

#### Returns

[RTCPeerConnection](rtcpeerconnection.md)

#### Inherited from

[EventTarget](eventtarget.md).[addListener](eventtarget.md#addlistener)

#### Defined in

node_modules/@types/node/events.d.ts:72

___

### addTrack

▸ **addTrack**(`track`, `ms?`): `RTCRtpSender`

#### Parameters

| Name | Type |
| :------ | :------ |
| `track` | [MediaStreamTrack](mediastreamtrack.md) |
| `ms?` | [MediaStream](mediastream.md) |

#### Returns

`RTCRtpSender`

#### Defined in

[packages/webrtc/src/peerConnection.ts:867](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L867)

___

### addTransceiver

▸ **addTransceiver**(`trackOrKind`, `options?`): [RTCRtpTransceiver](rtcrtptransceiver.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `trackOrKind` | [Kind](../modules.md#kind) \| [MediaStreamTrack](mediastreamtrack.md) |
| `options` | `Partial`<[TransceiverOptions](../interfaces/transceiveroptions.md)\> |

#### Returns

[RTCRtpTransceiver](rtcrtptransceiver.md)

#### Defined in

[packages/webrtc/src/peerConnection.ts:825](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L825)

___

### assertNotClosed

▸ `Private` **assertNotClosed**(): `void`

#### Returns

`void`

#### Defined in

[packages/webrtc/src/peerConnection.ts:999](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L999)

___

### close

▸ **close**(): `Promise`<void\>

#### Returns

`Promise`<void\>

#### Defined in

[packages/webrtc/src/peerConnection.ts:977](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L977)

___

### connect

▸ `Private` **connect**(): `Promise`<void\>

#### Returns

`Promise`<void\>

#### Defined in

[packages/webrtc/src/peerConnection.ts:522](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L522)

___

### createAnswer

▸ **createAnswer**(): `Promise`<[RTCSessionDescription](rtcsessiondescription.md)\>

#### Returns

`Promise`<[RTCSessionDescription](rtcsessiondescription.md)\>

#### Defined in

[packages/webrtc/src/peerConnection.ts:913](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L913)

___

### createDataChannel

▸ **createDataChannel**(`label`, `options?`): [RTCDataChannel](rtcdatachannel.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `label` | `string` |
| `options` | `Partial`<`Object`\> |

#### Returns

[RTCDataChannel](rtcdatachannel.md)

#### Defined in

[packages/webrtc/src/peerConnection.ts:281](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L281)

___

### createOffer

▸ **createOffer**(): `Promise`<[RTCSessionDescription](rtcsessiondescription.md)\>

#### Returns

`Promise`<[RTCSessionDescription](rtcsessiondescription.md)\>

#### Defined in

[packages/webrtc/src/peerConnection.ts:197](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L197)

___

### createSctpTransport

▸ `Private` **createSctpTransport**(): [RTCSctpTransport](rtcsctptransport.md)

#### Returns

[RTCSctpTransport](rtcsctptransport.md)

#### Defined in

[packages/webrtc/src/peerConnection.ts:404](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L404)

___

### createTransport

▸ `Private` **createTransport**(`srtpProfiles?`): `Object`

#### Parameters

| Name | Type | Default value |
| :------ | :------ | :------ |
| `srtpProfiles` | `number`[] | [] |

#### Returns

`Object`

| Name | Type |
| :------ | :------ |
| `dtlsTransport` | [RTCDtlsTransport](rtcdtlstransport.md) |
| `iceTransport` | [RTCIceTransport](rtcicetransport.md) |

#### Defined in

[packages/webrtc/src/peerConnection.ts:359](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L359)

___

### dispose

▸ `Private` **dispose**(): `void`

#### Returns

`void`

#### Defined in

[packages/webrtc/src/peerConnection.ts:1032](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L1032)

___

### emit

▸ **emit**(`event`, ...`args`): `boolean`

#### Parameters

| Name | Type |
| :------ | :------ |
| `event` | `string` \| `symbol` |
| `...args` | `any`[] |

#### Returns

`boolean`

#### Inherited from

[EventTarget](eventtarget.md).[emit](eventtarget.md#emit)

#### Defined in

node_modules/@types/node/events.d.ts:82

___

### eventNames

▸ **eventNames**(): (`string` \| `symbol`)[]

#### Returns

(`string` \| `symbol`)[]

#### Inherited from

[EventTarget](eventtarget.md).[eventNames](eventtarget.md#eventnames)

#### Defined in

node_modules/@types/node/events.d.ts:87

___

### fireOnTrack

▸ `Private` **fireOnTrack**(`track`, `transceiver`, `stream`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `track` | [MediaStreamTrack](mediastreamtrack.md) |
| `transceiver` | [RTCRtpTransceiver](rtcrtptransceiver.md) |
| `stream` | [MediaStream](mediastream.md) |

#### Returns

`void`

#### Defined in

[packages/webrtc/src/peerConnection.ts:810](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L810)

___

### getMaxListeners

▸ **getMaxListeners**(): `number`

#### Returns

`number`

#### Inherited from

[EventTarget](eventtarget.md).[getMaxListeners](eventtarget.md#getmaxlisteners)

#### Defined in

node_modules/@types/node/events.d.ts:79

___

### getReceivers

▸ **getReceivers**(): `RTCRtpReceiver`[]

#### Returns

`RTCRtpReceiver`[]

#### Defined in

[packages/webrtc/src/peerConnection.ts:862](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L862)

___

### getSenders

▸ **getSenders**(): `RTCRtpSender`[]

#### Returns

`RTCRtpSender`[]

#### Defined in

[packages/webrtc/src/peerConnection.ts:858](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L858)

___

### getTransceiverByMLineIndex

▸ `Private` **getTransceiverByMLineIndex**(`index`): `undefined` \| [RTCRtpTransceiver](rtcrtptransceiver.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `index` | `number` |

#### Returns

`undefined` \| [RTCRtpTransceiver](rtcrtptransceiver.md)

#### Defined in

[packages/webrtc/src/peerConnection.ts:191](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L191)

___

### getTransceiverByMid

▸ `Private` **getTransceiverByMid**(`mid`): `undefined` \| [RTCRtpTransceiver](rtcrtptransceiver.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `mid` | `string` |

#### Returns

`undefined` \| [RTCRtpTransceiver](rtcrtptransceiver.md)

#### Defined in

[packages/webrtc/src/peerConnection.ts:187](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L187)

___

### getTransceivers

▸ **getTransceivers**(): [RTCRtpTransceiver](rtcrtptransceiver.md)[]

#### Returns

[RTCRtpTransceiver](rtcrtptransceiver.md)[]

#### Defined in

[packages/webrtc/src/peerConnection.ts:854](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L854)

___

### listenerCount

▸ **listenerCount**(`event`): `number`

#### Parameters

| Name | Type |
| :------ | :------ |
| `event` | `string` \| `symbol` |

#### Returns

`number`

#### Inherited from

[EventTarget](eventtarget.md).[listenerCount](eventtarget.md#listenercount)

#### Defined in

node_modules/@types/node/events.d.ts:83

___

### listeners

▸ **listeners**(`event`): `Function`[]

#### Parameters

| Name | Type |
| :------ | :------ |
| `event` | `string` \| `symbol` |

#### Returns

`Function`[]

#### Inherited from

[EventTarget](eventtarget.md).[listeners](eventtarget.md#listeners)

#### Defined in

node_modules/@types/node/events.d.ts:80

___

### localRtp

▸ `Private` **localRtp**(`transceiver`): [RTCRtpParameters](../interfaces/rtcrtpparameters.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `transceiver` | [RTCRtpTransceiver](rtcrtptransceiver.md) |

#### Returns

[RTCRtpParameters](../interfaces/rtcrtpparameters.md)

#### Defined in

[packages/webrtc/src/peerConnection.ts:548](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L548)

___

### needNegotiation

▸ `Private` **needNegotiation**(): `Promise`<void\>

#### Returns

`Promise`<void\>

#### Defined in

[packages/webrtc/src/peerConnection.ts:348](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L348)

___

### off

▸ **off**(`event`, `listener`): [RTCPeerConnection](rtcpeerconnection.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `event` | `string` \| `symbol` |
| `listener` | (...`args`: `any`[]) => `void` |

#### Returns

[RTCPeerConnection](rtcpeerconnection.md)

#### Inherited from

[EventTarget](eventtarget.md).[off](eventtarget.md#off)

#### Defined in

node_modules/@types/node/events.d.ts:76

___

### on

▸ **on**(`event`, `listener`): [RTCPeerConnection](rtcpeerconnection.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `event` | `string` \| `symbol` |
| `listener` | (...`args`: `any`[]) => `void` |

#### Returns

[RTCPeerConnection](rtcpeerconnection.md)

#### Inherited from

[EventTarget](eventtarget.md).[on](eventtarget.md#on)

#### Defined in

node_modules/@types/node/events.d.ts:73

___

### once

▸ **once**(`event`, `listener`): [RTCPeerConnection](rtcpeerconnection.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `event` | `string` \| `symbol` |
| `listener` | (...`args`: `any`[]) => `void` |

#### Returns

[RTCPeerConnection](rtcpeerconnection.md)

#### Inherited from

[EventTarget](eventtarget.md).[once](eventtarget.md#once)

#### Defined in

node_modules/@types/node/events.d.ts:74

___

### prependListener

▸ **prependListener**(`event`, `listener`): [RTCPeerConnection](rtcpeerconnection.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `event` | `string` \| `symbol` |
| `listener` | (...`args`: `any`[]) => `void` |

#### Returns

[RTCPeerConnection](rtcpeerconnection.md)

#### Inherited from

[EventTarget](eventtarget.md).[prependListener](eventtarget.md#prependlistener)

#### Defined in

node_modules/@types/node/events.d.ts:85

___

### prependOnceListener

▸ **prependOnceListener**(`event`, `listener`): [RTCPeerConnection](rtcpeerconnection.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `event` | `string` \| `symbol` |
| `listener` | (...`args`: `any`[]) => `void` |

#### Returns

[RTCPeerConnection](rtcpeerconnection.md)

#### Inherited from

[EventTarget](eventtarget.md).[prependOnceListener](eventtarget.md#prependoncelistener)

#### Defined in

node_modules/@types/node/events.d.ts:86

___

### rawListeners

▸ **rawListeners**(`event`): `Function`[]

#### Parameters

| Name | Type |
| :------ | :------ |
| `event` | `string` \| `symbol` |

#### Returns

`Function`[]

#### Inherited from

[EventTarget](eventtarget.md).[rawListeners](eventtarget.md#rawlisteners)

#### Defined in

node_modules/@types/node/events.d.ts:81

___

### remoteRtp

▸ `Private` **remoteRtp**(`remoteDescription`, `transceiver`): [RTCRtpReceiveParameters](../interfaces/rtcrtpreceiveparameters.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `remoteDescription` | [SessionDescription](sessiondescription.md) |
| `transceiver` | [RTCRtpTransceiver](rtcrtptransceiver.md) |

#### Returns

[RTCRtpReceiveParameters](../interfaces/rtcrtpreceiveparameters.md)

#### Defined in

[packages/webrtc/src/peerConnection.ts:560](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L560)

___

### removeAllListeners

▸ **removeAllListeners**(`event?`): [RTCPeerConnection](rtcpeerconnection.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `event?` | `string` \| `symbol` |

#### Returns

[RTCPeerConnection](rtcpeerconnection.md)

#### Inherited from

[EventTarget](eventtarget.md).[removeAllListeners](eventtarget.md#removealllisteners)

#### Defined in

node_modules/@types/node/events.d.ts:77

___

### removeEventListener

▸ **removeEventListener**(`type`, `listener`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `type` | `string` |
| `listener` | (...`args`: `any`[]) => `void` |

#### Returns

`void`

#### Inherited from

[EventTarget](eventtarget.md).[removeEventListener](eventtarget.md#removeeventlistener)

#### Defined in

[packages/webrtc/src/helper.ts:41](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/helper.ts#L41)

___

### removeListener

▸ **removeListener**(`event`, `listener`): [RTCPeerConnection](rtcpeerconnection.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `event` | `string` \| `symbol` |
| `listener` | (...`args`: `any`[]) => `void` |

#### Returns

[RTCPeerConnection](rtcpeerconnection.md)

#### Inherited from

[EventTarget](eventtarget.md).[removeListener](eventtarget.md#removelistener)

#### Defined in

node_modules/@types/node/events.d.ts:75

___

### removeTrack

▸ **removeTrack**(`sender`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `sender` | `RTCRtpSender` |

#### Returns

`void`

#### Defined in

[packages/webrtc/src/peerConnection.ts:320](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L320)

___

### setConnectionState

▸ `Private` **setConnectionState**(`state`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `state` | ``"closed"`` \| ``"connecting"`` \| ``"failed"`` \| ``"disconnected"`` \| ``"new"`` \| ``"connected"`` |

#### Returns

`void`

#### Defined in

[packages/webrtc/src/peerConnection.ts:1024](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L1024)

___

### setLocal

▸ `Private` **setLocal**(`description`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `description` | [SessionDescription](sessiondescription.md) |

#### Returns

`void`

#### Defined in

[packages/webrtc/src/peerConnection.ts:508](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L508)

___

### setLocalDescription

▸ **setLocalDescription**(`sessionDescription`): `Promise`<undefined \| [RTCSessionDescription](rtcsessiondescription.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `sessionDescription` | `Object` |
| `sessionDescription.sdp` | `string` |
| `sessionDescription.type` | ``"offer"`` \| ``"answer"`` |

#### Returns

`Promise`<undefined \| [RTCSessionDescription](rtcsessiondescription.md)\>

#### Defined in

[packages/webrtc/src/peerConnection.ts:419](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L419)

___

### setMaxListeners

▸ **setMaxListeners**(`n`): [RTCPeerConnection](rtcpeerconnection.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `n` | `number` |

#### Returns

[RTCPeerConnection](rtcpeerconnection.md)

#### Inherited from

[EventTarget](eventtarget.md).[setMaxListeners](eventtarget.md#setmaxlisteners)

#### Defined in

node_modules/@types/node/events.d.ts:78

___

### setRemoteDescription

▸ **setRemoteDescription**(`sessionDescription`): `Promise`<void\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `sessionDescription` | `Object` |
| `sessionDescription.sdp` | `string` |
| `sessionDescription.type` | ``"offer"`` \| ``"answer"`` |

#### Returns

`Promise`<void\>

#### Defined in

[packages/webrtc/src/peerConnection.ts:642](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L642)

___

### setSignalingState

▸ `Private` **setSignalingState**(`state`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `state` | ``"closed"`` \| ``"stable"`` \| ``"have-local-offer"`` \| ``"have-remote-offer"`` \| ``"have-local-pranswer"`` \| ``"have-remote-pranswer"`` |

#### Returns

`void`

#### Defined in

[packages/webrtc/src/peerConnection.ts:1017](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L1017)

___

### updateIceConnectionState

▸ `Private` **updateIceConnectionState**(`state`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `state` | ``"closed"`` \| ``"failed"`` \| ``"disconnected"`` \| ``"new"`` \| ``"connected"`` \| ``"checking"`` \| ``"completed"`` |

#### Returns

`void`

#### Defined in

[packages/webrtc/src/peerConnection.ts:1010](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L1010)

___

### updateIceGatheringState

▸ `Private` **updateIceGatheringState**(`state`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `state` | ``"new"`` \| ``"gathering"`` \| ``"complete"`` |

#### Returns

`void`

#### Defined in

[packages/webrtc/src/peerConnection.ts:1003](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L1003)

___

### validateDescription

▸ `Private` **validateDescription**(`description`, `isLocal`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `description` | [SessionDescription](sessiondescription.md) |
| `isLocal` | `boolean` |

#### Returns

`void`

#### Defined in

[packages/webrtc/src/peerConnection.ts:588](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/peerConnection.ts#L588)

___

### getEventListener

▸ `Static` **getEventListener**(`emitter`, `name`): `Function`[]

Returns a list listener for a specific emitter event name.

#### Parameters

| Name | Type |
| :------ | :------ |
| `emitter` | `DOMEventTarget` \| `EventEmitter` |
| `name` | `string` \| `symbol` |

#### Returns

`Function`[]

#### Inherited from

[EventTarget](eventtarget.md).[getEventListener](eventtarget.md#geteventlistener)

#### Defined in

node_modules/@types/node/events.d.ts:34

___

### listenerCount

▸ `Static` **listenerCount**(`emitter`, `event`): `number`

**`deprecated`** since v4.0.0

#### Parameters

| Name | Type |
| :------ | :------ |
| `emitter` | `EventEmitter` |
| `event` | `string` \| `symbol` |

#### Returns

`number`

#### Inherited from

[EventTarget](eventtarget.md).[listenerCount](eventtarget.md#listenercount)

#### Defined in

node_modules/@types/node/events.d.ts:30

___

### on

▸ `Static` **on**(`emitter`, `event`, `options?`): `AsyncIterableIterator`<any\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `emitter` | `EventEmitter` |
| `event` | `string` |
| `options?` | `StaticEventEmitterOptions` |

#### Returns

`AsyncIterableIterator`<any\>

#### Inherited from

[EventTarget](eventtarget.md).[on](eventtarget.md#on)

#### Defined in

node_modules/@types/node/events.d.ts:27

___

### once

▸ `Static` **once**(`emitter`, `event`, `options?`): `Promise`<any[]\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `emitter` | `NodeEventTarget` |
| `event` | `string` \| `symbol` |
| `options?` | `StaticEventEmitterOptions` |

#### Returns

`Promise`<any[]\>

#### Inherited from

[EventTarget](eventtarget.md).[once](eventtarget.md#once)

#### Defined in

node_modules/@types/node/events.d.ts:25

▸ `Static` **once**(`emitter`, `event`, `options?`): `Promise`<any[]\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `emitter` | `DOMEventTarget` |
| `event` | `string` |
| `options?` | `StaticEventEmitterOptions` |

#### Returns

`Promise`<any[]\>

#### Inherited from

[EventTarget](eventtarget.md).[once](eventtarget.md#once)

#### Defined in

node_modules/@types/node/events.d.ts:26

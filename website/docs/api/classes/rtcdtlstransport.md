---
id: "rtcdtlstransport"
title: "Class: RTCDtlsTransport"
sidebar_label: "RTCDtlsTransport"
sidebar_position: 0
custom_edit_url: null
---

## Constructors

### constructor

• **new RTCDtlsTransport**(`iceTransport`, `router`, `certificates`, `srtpProfiles?`)

#### Parameters

| Name | Type | Default value |
| :------ | :------ | :------ |
| `iceTransport` | [RTCIceTransport](rtcicetransport.md) | `undefined` |
| `router` | `RtpRouter` | `undefined` |
| `certificates` | [RTCCertificate](rtccertificate.md)[] | `undefined` |
| `srtpProfiles` | `number`[] | [] |

#### Defined in

[packages/webrtc/src/transport/dtls.ts:46](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/dtls.ts#L46)

## Properties

### certificates

• `Readonly` **certificates**: [RTCCertificate](rtccertificate.md)[]

___

### dataReceiver

• **dataReceiver**: (`buf`: `Buffer`) => `void`

#### Type declaration

▸ (`buf`): `void`

##### Parameters

| Name | Type |
| :------ | :------ |
| `buf` | `Buffer` |

##### Returns

`void`

#### Defined in

[packages/webrtc/src/transport/dtls.ts:39](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/dtls.ts#L39)

___

### dtls

• `Optional` **dtls**: `DtlsSocket`

#### Defined in

[packages/webrtc/src/transport/dtls.ts:40](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/dtls.ts#L40)

___

### iceTransport

• `Readonly` **iceTransport**: [RTCIceTransport](rtcicetransport.md)

___

### localCertificate

• `Private` `Optional` **localCertificate**: [RTCCertificate](rtccertificate.md)

#### Defined in

[packages/webrtc/src/transport/dtls.ts:46](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/dtls.ts#L46)

___

### onStateChange

• `Readonly` **onStateChange**: `default`<[``"closed"`` \| ``"connecting"`` \| ``"failed"`` \| ``"new"`` \| ``"connected"``]\>

#### Defined in

[packages/webrtc/src/transport/dtls.ts:44](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/dtls.ts#L44)

___

### role

• **role**: `DtlsRole` = "auto"

#### Defined in

[packages/webrtc/src/transport/dtls.ts:35](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/dtls.ts#L35)

___

### router

• `Readonly` **router**: `RtpRouter`

___

### srtcp

• **srtcp**: [SrtcpSession](srtcpsession.md)

#### Defined in

[packages/webrtc/src/transport/dtls.ts:42](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/dtls.ts#L42)

___

### srtp

• **srtp**: [SrtpSession](srtpsession.md)

#### Defined in

[packages/webrtc/src/transport/dtls.ts:41](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/dtls.ts#L41)

___

### srtpStarted

• **srtpStarted**: `boolean` = false

#### Defined in

[packages/webrtc/src/transport/dtls.ts:36](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/dtls.ts#L36)

___

### state

• **state**: ``"closed"`` \| ``"connecting"`` \| ``"failed"`` \| ``"new"`` \| ``"connected"`` = "new"

#### Defined in

[packages/webrtc/src/transport/dtls.ts:34](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/dtls.ts#L34)

___

### transportSequenceNumber

• **transportSequenceNumber**: `number` = 0

#### Defined in

[packages/webrtc/src/transport/dtls.ts:37](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/dtls.ts#L37)

## Accessors

### localParameters

• `get` **localParameters**(): `RTCDtlsParameters`

#### Returns

`RTCDtlsParameters`

#### Defined in

[packages/webrtc/src/transport/dtls.ts:55](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/dtls.ts#L55)

## Methods

### sendData

▸ `Readonly` **sendData**(`data`): `Promise`<void\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |

#### Returns

`Promise`<void\>

#### Defined in

[packages/webrtc/src/transport/dtls.ts:170](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/dtls.ts#L170)

___

### sendRtcp

▸ **sendRtcp**(`packets`): `Promise`<void\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `packets` | [RtcpPacket](../modules.md#rtcppacket)[] |

#### Returns

`Promise`<void\>

#### Defined in

[packages/webrtc/src/transport/dtls.ts:181](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/dtls.ts#L181)

___

### sendRtp

▸ **sendRtp**(`payload`, `header`): `number`

#### Parameters

| Name | Type |
| :------ | :------ |
| `payload` | `Buffer` |
| `header` | [RtpHeader](rtpheader.md) |

#### Returns

`number`

#### Defined in

[packages/webrtc/src/transport/dtls.ts:175](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/dtls.ts#L175)

___

### setState

▸ `Private` **setState**(`state`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `state` | ``"closed"`` \| ``"connecting"`` \| ``"failed"`` \| ``"new"`` \| ``"connected"`` |

#### Returns

`void`

#### Defined in

[packages/webrtc/src/transport/dtls.ts:191](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/dtls.ts#L191)

___

### setupCertificate

▸ **setupCertificate**(): `Promise`<void\>

#### Returns

`Promise`<void\>

#### Defined in

[packages/webrtc/src/transport/dtls.ts:62](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/dtls.ts#L62)

___

### start

▸ **start**(`remoteParameters`): `Promise`<void\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `remoteParameters` | `RTCDtlsParameters` |

#### Returns

`Promise`<void\>

#### Defined in

[packages/webrtc/src/transport/dtls.ts:80](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/dtls.ts#L80)

___

### startSrtp

▸ **startSrtp**(): `void`

#### Returns

`void`

#### Defined in

[packages/webrtc/src/transport/dtls.ts:135](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/dtls.ts#L135)

___

### stop

▸ **stop**(): `Promise`<void\>

#### Returns

`Promise`<void\>

#### Defined in

[packages/webrtc/src/transport/dtls.ts:198](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/dtls.ts#L198)

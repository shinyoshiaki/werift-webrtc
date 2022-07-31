[werift](../README.md) / [Exports](../modules.md) / RTCDtlsTransport

# Class: RTCDtlsTransport

## Table of contents

### Constructors

- [constructor](RTCDtlsTransport.md#constructor)

### Properties

- [certificates](RTCDtlsTransport.md#certificates)
- [config](RTCDtlsTransport.md#config)
- [dataReceiver](RTCDtlsTransport.md#datareceiver)
- [dtls](RTCDtlsTransport.md#dtls)
- [iceTransport](RTCDtlsTransport.md#icetransport)
- [id](RTCDtlsTransport.md#id)
- [localCertificate](RTCDtlsTransport.md#localcertificate)
- [onStateChange](RTCDtlsTransport.md#onstatechange)
- [remoteParameters](RTCDtlsTransport.md#remoteparameters)
- [role](RTCDtlsTransport.md#role)
- [router](RTCDtlsTransport.md#router)
- [srtcp](RTCDtlsTransport.md#srtcp)
- [srtp](RTCDtlsTransport.md#srtp)
- [srtpStarted](RTCDtlsTransport.md#srtpstarted)
- [state](RTCDtlsTransport.md#state)
- [transportSequenceNumber](RTCDtlsTransport.md#transportsequencenumber)

### Accessors

- [localParameters](RTCDtlsTransport.md#localparameters)

### Methods

- [sendData](RTCDtlsTransport.md#senddata)
- [sendRtcp](RTCDtlsTransport.md#sendrtcp)
- [sendRtp](RTCDtlsTransport.md#sendrtp)
- [setRemoteParams](RTCDtlsTransport.md#setremoteparams)
- [setState](RTCDtlsTransport.md#setstate)
- [setupCertificate](RTCDtlsTransport.md#setupcertificate)
- [start](RTCDtlsTransport.md#start)
- [startSrtp](RTCDtlsTransport.md#startsrtp)
- [stop](RTCDtlsTransport.md#stop)

## Constructors

### constructor

• **new RTCDtlsTransport**(`config`, `iceTransport`, `router`, `certificates`, `srtpProfiles?`)

#### Parameters

| Name | Type | Default value |
| :------ | :------ | :------ |
| `config` | [`PeerConfig`](../interfaces/PeerConfig.md) | `undefined` |
| `iceTransport` | [`RTCIceTransport`](RTCIceTransport.md) | `undefined` |
| `router` | `RtpRouter` | `undefined` |
| `certificates` | [`RTCCertificate`](RTCCertificate.md)[] | `undefined` |
| `srtpProfiles` | (``1`` \| ``7``)[] | `[]` |

#### Defined in

[packages/webrtc/src/transport/dtls.ts:55](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/dtls.ts#L55)

## Properties

### certificates

• `Readonly` **certificates**: [`RTCCertificate`](RTCCertificate.md)[]

#### Defined in

[packages/webrtc/src/transport/dtls.ts:59](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/dtls.ts#L59)

___

### config

• `Readonly` **config**: [`PeerConfig`](../interfaces/PeerConfig.md)

#### Defined in

[packages/webrtc/src/transport/dtls.ts:56](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/dtls.ts#L56)

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

[packages/webrtc/src/transport/dtls.ts:45](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/dtls.ts#L45)

___

### dtls

• `Optional` **dtls**: `DtlsSocket`

#### Defined in

[packages/webrtc/src/transport/dtls.ts:46](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/dtls.ts#L46)

___

### iceTransport

• `Readonly` **iceTransport**: [`RTCIceTransport`](RTCIceTransport.md)

#### Defined in

[packages/webrtc/src/transport/dtls.ts:57](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/dtls.ts#L57)

___

### id

• **id**: `string`

#### Defined in

[packages/webrtc/src/transport/dtls.ts:39](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/dtls.ts#L39)

___

### localCertificate

• `Optional` **localCertificate**: [`RTCCertificate`](RTCCertificate.md)

#### Defined in

[packages/webrtc/src/transport/dtls.ts:52](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/dtls.ts#L52)

___

### onStateChange

• `Readonly` **onStateChange**: `default`<[``"closed"`` \| ``"new"`` \| ``"connected"`` \| ``"connecting"`` \| ``"failed"``]\>

#### Defined in

[packages/webrtc/src/transport/dtls.ts:50](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/dtls.ts#L50)

___

### remoteParameters

• `Private` `Optional` **remoteParameters**: [`RTCDtlsParameters`](RTCDtlsParameters.md)

#### Defined in

[packages/webrtc/src/transport/dtls.ts:53](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/dtls.ts#L53)

___

### role

• **role**: [`DtlsRole`](../modules.md#dtlsrole) = `"auto"`

#### Defined in

[packages/webrtc/src/transport/dtls.ts:41](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/dtls.ts#L41)

___

### router

• `Readonly` **router**: `RtpRouter`

#### Defined in

[packages/webrtc/src/transport/dtls.ts:58](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/dtls.ts#L58)

___

### srtcp

• **srtcp**: [`SrtcpSession`](SrtcpSession.md)

#### Defined in

[packages/webrtc/src/transport/dtls.ts:48](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/dtls.ts#L48)

___

### srtp

• **srtp**: [`SrtpSession`](SrtpSession.md)

#### Defined in

[packages/webrtc/src/transport/dtls.ts:47](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/dtls.ts#L47)

___

### srtpStarted

• **srtpStarted**: `boolean` = `false`

#### Defined in

[packages/webrtc/src/transport/dtls.ts:42](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/dtls.ts#L42)

___

### state

• **state**: ``"closed"`` \| ``"new"`` \| ``"connected"`` \| ``"connecting"`` \| ``"failed"`` = `"new"`

#### Defined in

[packages/webrtc/src/transport/dtls.ts:40](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/dtls.ts#L40)

___

### transportSequenceNumber

• **transportSequenceNumber**: `number` = `0`

#### Defined in

[packages/webrtc/src/transport/dtls.ts:43](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/dtls.ts#L43)

## Accessors

### localParameters

• `get` **localParameters**(): [`RTCDtlsParameters`](RTCDtlsParameters.md)

#### Returns

[`RTCDtlsParameters`](RTCDtlsParameters.md)

#### Defined in

[packages/webrtc/src/transport/dtls.ts:63](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/dtls.ts#L63)

## Methods

### sendData

▸ `Readonly` **sendData**(`data`): `Promise`<`void`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |

#### Returns

`Promise`<`void`\>

#### Defined in

[packages/webrtc/src/transport/dtls.ts:210](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/dtls.ts#L210)

___

### sendRtcp

▸ **sendRtcp**(`packets`): `Promise`<`undefined` \| `number`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `packets` | [`RtcpPacket`](../modules.md#rtcppacket)[] |

#### Returns

`Promise`<`undefined` \| `number`\>

#### Defined in

[packages/webrtc/src/transport/dtls.ts:238](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/dtls.ts#L238)

___

### sendRtp

▸ **sendRtp**(`payload`, `header`): `Promise`<`number`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `payload` | `Buffer` |
| `header` | [`RtpHeader`](RtpHeader.md) |

#### Returns

`Promise`<`number`\>

#### Defined in

[packages/webrtc/src/transport/dtls.ts:224](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/dtls.ts#L224)

___

### setRemoteParams

▸ **setRemoteParams**(`remoteParameters`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `remoteParameters` | [`RTCDtlsParameters`](RTCDtlsParameters.md) |

#### Returns

`void`

#### Defined in

[packages/webrtc/src/transport/dtls.ts:89](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/dtls.ts#L89)

___

### setState

▸ `Private` **setState**(`state`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `state` | ``"closed"`` \| ``"new"`` \| ``"connected"`` \| ``"connecting"`` \| ``"failed"`` |

#### Returns

`void`

#### Defined in

[packages/webrtc/src/transport/dtls.ts:252](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/dtls.ts#L252)

___

### setupCertificate

▸ **setupCertificate**(): `Promise`<[`RTCCertificate`](RTCCertificate.md)\>

#### Returns

`Promise`<[`RTCCertificate`](RTCCertificate.md)\>

#### Defined in

[packages/webrtc/src/transport/dtls.ts:70](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/dtls.ts#L70)

___

### start

▸ **start**(): `Promise`<`void`\>

#### Returns

`Promise`<`void`\>

#### Defined in

[packages/webrtc/src/transport/dtls.ts:93](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/dtls.ts#L93)

___

### startSrtp

▸ **startSrtp**(): `void`

#### Returns

`void`

#### Defined in

[packages/webrtc/src/transport/dtls.ts:162](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/dtls.ts#L162)

___

### stop

▸ **stop**(): `Promise`<`void`\>

#### Returns

`Promise`<`void`\>

#### Defined in

[packages/webrtc/src/transport/dtls.ts:259](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/dtls.ts#L259)

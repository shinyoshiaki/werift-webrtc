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
- [setupCertificate](RTCDtlsTransport.md#setupcertificate)
- [start](RTCDtlsTransport.md#start)
- [startSrtp](RTCDtlsTransport.md#startsrtp)
- [stop](RTCDtlsTransport.md#stop)
- [updateSrtpSession](RTCDtlsTransport.md#updatesrtpsession)

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

## Properties

### certificates

• `Readonly` **certificates**: [`RTCCertificate`](RTCCertificate.md)[]

___

### config

• `Readonly` **config**: [`PeerConfig`](../interfaces/PeerConfig.md)

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

___

### dtls

• `Optional` **dtls**: `DtlsSocket`

___

### iceTransport

• `Readonly` **iceTransport**: [`RTCIceTransport`](RTCIceTransport.md)

___

### id

• **id**: `string`

___

### localCertificate

• `Optional` **localCertificate**: [`RTCCertificate`](RTCCertificate.md)

___

### onStateChange

• `Readonly` **onStateChange**: `Event`<[``"closed"`` \| ``"new"`` \| ``"connected"`` \| ``"connecting"`` \| ``"failed"``]\>

___

### role

• **role**: [`DtlsRole`](../modules.md#dtlsrole) = `"auto"`

___

### router

• `Readonly` **router**: `RtpRouter`

___

### srtcp

• **srtcp**: [`SrtcpSession`](SrtcpSession.md)

___

### srtp

• **srtp**: [`SrtpSession`](SrtpSession.md)

___

### srtpStarted

• **srtpStarted**: `boolean` = `false`

___

### state

• **state**: ``"closed"`` \| ``"new"`` \| ``"connected"`` \| ``"connecting"`` \| ``"failed"`` = `"new"`

___

### transportSequenceNumber

• **transportSequenceNumber**: `number` = `0`

## Accessors

### localParameters

• `get` **localParameters**(): [`RTCDtlsParameters`](RTCDtlsParameters.md)

#### Returns

[`RTCDtlsParameters`](RTCDtlsParameters.md)

## Methods

### sendData

▸ `Readonly` **sendData**(`data`): `Promise`<`void`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |

#### Returns

`Promise`<`void`\>

___

### sendRtcp

▸ **sendRtcp**(`packets`): `Promise`<`undefined` \| `number`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `packets` | [`RtcpPacket`](../modules.md#rtcppacket)[] |

#### Returns

`Promise`<`undefined` \| `number`\>

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

___

### setRemoteParams

▸ **setRemoteParams**(`remoteParameters`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `remoteParameters` | [`RTCDtlsParameters`](RTCDtlsParameters.md) |

#### Returns

`void`

___

### setupCertificate

▸ **setupCertificate**(): `Promise`<[`RTCCertificate`](RTCCertificate.md)\>

#### Returns

`Promise`<[`RTCCertificate`](RTCCertificate.md)\>

___

### start

▸ **start**(): `Promise`<`void`\>

#### Returns

`Promise`<`void`\>

___

### startSrtp

▸ **startSrtp**(): `void`

#### Returns

`void`

___

### stop

▸ **stop**(): `Promise`<`void`\>

#### Returns

`Promise`<`void`\>

___

### updateSrtpSession

▸ **updateSrtpSession**(): `void`

#### Returns

`void`

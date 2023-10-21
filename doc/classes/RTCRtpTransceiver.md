[werift](../README.md) / [Exports](../modules.md) / RTCRtpTransceiver

# Class: RTCRtpTransceiver

## Table of contents

### Constructors

- [constructor](RTCRtpTransceiver.md#constructor)

### Properties

- [\_codecs](RTCRtpTransceiver.md#_codecs)
- [headerExtensions](RTCRtpTransceiver.md#headerextensions)
- [id](RTCRtpTransceiver.md#id)
- [kind](RTCRtpTransceiver.md#kind)
- [mLineIndex](RTCRtpTransceiver.md#mlineindex)
- [mid](RTCRtpTransceiver.md#mid)
- [offerDirection](RTCRtpTransceiver.md#offerdirection)
- [onTrack](RTCRtpTransceiver.md#ontrack)
- [options](RTCRtpTransceiver.md#options)
- [receiver](RTCRtpTransceiver.md#receiver)
- [sender](RTCRtpTransceiver.md#sender)
- [stopped](RTCRtpTransceiver.md#stopped)
- [stopping](RTCRtpTransceiver.md#stopping)
- [usedForSender](RTCRtpTransceiver.md#usedforsender)

### Accessors

- [codecs](RTCRtpTransceiver.md#codecs)
- [currentDirection](RTCRtpTransceiver.md#currentdirection)
- [direction](RTCRtpTransceiver.md#direction)
- [dtlsTransport](RTCRtpTransceiver.md#dtlstransport)
- [msid](RTCRtpTransceiver.md#msid)

### Methods

- [addTrack](RTCRtpTransceiver.md#addtrack)
- [getPayloadType](RTCRtpTransceiver.md#getpayloadtype)
- [setCurrentDirection](RTCRtpTransceiver.md#setcurrentdirection)
- [setDirection](RTCRtpTransceiver.md#setdirection)
- [setDtlsTransport](RTCRtpTransceiver.md#setdtlstransport)
- [stop](RTCRtpTransceiver.md#stop)

## Constructors

### constructor

• **new RTCRtpTransceiver**(`kind`, `dtlsTransport`, `receiver`, `sender`, `_direction`)

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `kind` | [`Kind`](../modules.md#kind) | - |
| `dtlsTransport` | [`RTCDtlsTransport`](RTCDtlsTransport.md) | - |
| `receiver` | `RTCRtpReceiver` | - |
| `sender` | `RTCRtpSender` | - |
| `_direction` | ``"inactive"`` \| ``"sendonly"`` \| ``"recvonly"`` \| ``"sendrecv"`` | RFC 8829 4.2.4. direction the transceiver was initialized with |

## Properties

### \_codecs

• **\_codecs**: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[] = `[]`

___

### headerExtensions

• **headerExtensions**: [`RTCRtpHeaderExtensionParameters`](RTCRtpHeaderExtensionParameters.md)[] = `[]`

___

### id

• `Readonly` **id**: `string`

___

### kind

• `Readonly` **kind**: [`Kind`](../modules.md#kind)

___

### mLineIndex

• `Optional` **mLineIndex**: `number`

___

### mid

• `Optional` **mid**: `string`

___

### offerDirection

• **offerDirection**: ``"inactive"`` \| ``"sendonly"`` \| ``"recvonly"`` \| ``"sendrecv"``

___

### onTrack

• `Readonly` **onTrack**: `Event`<[[`MediaStreamTrack`](MediaStreamTrack.md), [`RTCRtpTransceiver`](RTCRtpTransceiver.md)]\>

___

### options

• **options**: `Partial`<[`TransceiverOptions`](../interfaces/TransceiverOptions.md)\> = `{}`

___

### receiver

• **receiver**: `RTCRtpReceiver`

___

### sender

• **sender**: `RTCRtpSender`

___

### stopped

• **stopped**: `boolean` = `false`

___

### stopping

• **stopping**: `boolean` = `false`

___

### usedForSender

• **usedForSender**: `boolean` = `false`

should not be reused because it has been used for sending before.

## Accessors

### codecs

• `get` **codecs**(): [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[]

#### Returns

[`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[]

• `set` **codecs**(`codecs`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `codecs` | [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[] |

#### Returns

`void`

___

### currentDirection

• `get` **currentDirection**(): `undefined` \| ``"inactive"`` \| ``"sendonly"`` \| ``"recvonly"`` \| ``"sendrecv"``

RFC 8829 4.2.5. last negotiated direction

#### Returns

`undefined` \| ``"inactive"`` \| ``"sendonly"`` \| ``"recvonly"`` \| ``"sendrecv"``

___

### direction

• `get` **direction**(): ``"inactive"`` \| ``"sendonly"`` \| ``"recvonly"`` \| ``"sendrecv"``

RFC 8829 4.2.4. setDirectionに渡された最後の値を示します

#### Returns

``"inactive"`` \| ``"sendonly"`` \| ``"recvonly"`` \| ``"sendrecv"``

___

### dtlsTransport

• `get` **dtlsTransport**(): [`RTCDtlsTransport`](RTCDtlsTransport.md)

#### Returns

[`RTCDtlsTransport`](RTCDtlsTransport.md)

___

### msid

• `get` **msid**(): `string`

#### Returns

`string`

## Methods

### addTrack

▸ **addTrack**(`track`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `track` | [`MediaStreamTrack`](MediaStreamTrack.md) |

#### Returns

`void`

___

### getPayloadType

▸ **getPayloadType**(`mimeType`): `undefined` \| `number`

#### Parameters

| Name | Type |
| :------ | :------ |
| `mimeType` | `string` |

#### Returns

`undefined` \| `number`

___

### setCurrentDirection

▸ **setCurrentDirection**(`direction`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `direction` | `undefined` \| ``"inactive"`` \| ``"sendonly"`` \| ``"recvonly"`` \| ``"sendrecv"`` |

#### Returns

`void`

___

### setDirection

▸ **setDirection**(`direction`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `direction` | ``"inactive"`` \| ``"sendonly"`` \| ``"recvonly"`` \| ``"sendrecv"`` |

#### Returns

`void`

___

### setDtlsTransport

▸ **setDtlsTransport**(`dtls`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `dtls` | [`RTCDtlsTransport`](RTCDtlsTransport.md) |

#### Returns

`void`

___

### stop

▸ **stop**(): `void`

#### Returns

`void`

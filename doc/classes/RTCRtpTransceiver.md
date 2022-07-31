[werift](../README.md) / [Exports](../modules.md) / RTCRtpTransceiver

# Class: RTCRtpTransceiver

## Table of contents

### Constructors

- [constructor](RTCRtpTransceiver.md#constructor)

### Properties

- [\_codecs](RTCRtpTransceiver.md#_codecs)
- [\_currentDirection](RTCRtpTransceiver.md#_currentdirection)
- [direction](RTCRtpTransceiver.md#direction)
- [headerExtensions](RTCRtpTransceiver.md#headerextensions)
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
- [uuid](RTCRtpTransceiver.md#uuid)

### Accessors

- [codecs](RTCRtpTransceiver.md#codecs)
- [currentDirection](RTCRtpTransceiver.md#currentdirection)
- [dtlsTransport](RTCRtpTransceiver.md#dtlstransport)
- [msid](RTCRtpTransceiver.md#msid)

### Methods

- [addTrack](RTCRtpTransceiver.md#addtrack)
- [getPayloadType](RTCRtpTransceiver.md#getpayloadtype)
- [setDtlsTransport](RTCRtpTransceiver.md#setdtlstransport)
- [stop](RTCRtpTransceiver.md#stop)

## Constructors

### constructor

• **new RTCRtpTransceiver**(`kind`, `dtlsTransport`, `receiver`, `sender`, `direction`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `kind` | [`Kind`](../modules.md#kind) |
| `dtlsTransport` | [`RTCDtlsTransport`](RTCDtlsTransport.md) |
| `receiver` | `RTCRtpReceiver` |
| `sender` | `RTCRtpSender` |
| `direction` | ``"inactive"`` \| ``"sendonly"`` \| ``"recvonly"`` \| ``"sendrecv"`` |

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:46](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/media/rtpTransceiver.ts#L46)

## Properties

### \_codecs

• **\_codecs**: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[] = `[]`

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:34](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/media/rtpTransceiver.ts#L34)

___

### \_currentDirection

• `Private` `Optional` **\_currentDirection**: ``"stopped"`` \| ``"inactive"`` \| ``"sendonly"`` \| ``"recvonly"`` \| ``"sendrecv"``

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:21](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/media/rtpTransceiver.ts#L21)

___

### direction

• **direction**: ``"inactive"`` \| ``"sendonly"`` \| ``"recvonly"`` \| ``"sendrecv"``

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:52](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/media/rtpTransceiver.ts#L52)

___

### headerExtensions

• **headerExtensions**: [`RTCRtpHeaderExtensionParameters`](RTCRtpHeaderExtensionParameters.md)[] = `[]`

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:41](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/media/rtpTransceiver.ts#L41)

___

### kind

• `Readonly` **kind**: [`Kind`](../modules.md#kind)

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:47](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/media/rtpTransceiver.ts#L47)

___

### mLineIndex

• `Optional` **mLineIndex**: `number`

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:19](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/media/rtpTransceiver.ts#L19)

___

### mid

• `Optional` **mid**: `string`

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:18](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/media/rtpTransceiver.ts#L18)

___

### offerDirection

• **offerDirection**: ``"inactive"`` \| ``"sendonly"`` \| ``"recvonly"`` \| ``"sendrecv"``

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:33](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/media/rtpTransceiver.ts#L33)

___

### onTrack

• `Readonly` **onTrack**: `default`<[[`MediaStreamTrack`](MediaStreamTrack.md)]\>

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:17](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/media/rtpTransceiver.ts#L17)

___

### options

• **options**: `Partial`<[`TransceiverOptions`](../interfaces/TransceiverOptions.md)\> = `{}`

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:42](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/media/rtpTransceiver.ts#L42)

___

### receiver

• **receiver**: `RTCRtpReceiver`

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:49](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/media/rtpTransceiver.ts#L49)

___

### sender

• **sender**: `RTCRtpSender`

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:50](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/media/rtpTransceiver.ts#L50)

___

### stopped

• **stopped**: `boolean` = `false`

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:44](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/media/rtpTransceiver.ts#L44)

___

### stopping

• **stopping**: `boolean` = `false`

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:43](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/media/rtpTransceiver.ts#L43)

___

### usedForSender

• **usedForSender**: `boolean` = `false`

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:20](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/media/rtpTransceiver.ts#L20)

___

### uuid

• `Readonly` **uuid**: `string`

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:16](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/media/rtpTransceiver.ts#L16)

## Accessors

### codecs

• `get` **codecs**(): [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[]

#### Returns

[`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[]

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:38](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/media/rtpTransceiver.ts#L38)

• `set` **codecs**(`codecs`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `codecs` | [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[] |

#### Returns

`void`

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:35](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/media/rtpTransceiver.ts#L35)

___

### currentDirection

• `get` **currentDirection**(): `undefined` \| ``"stopped"`` \| ``"inactive"`` \| ``"sendonly"`` \| ``"recvonly"`` \| ``"sendrecv"``

RFC 8829 4.2.5. last negotiated direction

#### Returns

`undefined` \| ``"stopped"`` \| ``"inactive"`` \| ``"sendonly"`` \| ``"recvonly"`` \| ``"sendrecv"``

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:29](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/media/rtpTransceiver.ts#L29)

• `set` **currentDirection**(`direction`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `direction` | `undefined` \| ``"stopped"`` \| ``"inactive"`` \| ``"sendonly"`` \| ``"recvonly"`` \| ``"sendrecv"`` |

#### Returns

`void`

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:22](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/media/rtpTransceiver.ts#L22)

___

### dtlsTransport

• `get` **dtlsTransport**(): [`RTCDtlsTransport`](RTCDtlsTransport.md)

#### Returns

[`RTCDtlsTransport`](RTCDtlsTransport.md)

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:57](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/media/rtpTransceiver.ts#L57)

___

### msid

• `get` **msid**(): `string`

#### Returns

`string`

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:66](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/media/rtpTransceiver.ts#L66)

## Methods

### addTrack

▸ **addTrack**(`track`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `track` | [`MediaStreamTrack`](MediaStreamTrack.md) |

#### Returns

`void`

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:70](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/media/rtpTransceiver.ts#L70)

___

### getPayloadType

▸ **getPayloadType**(`mimeType`): `undefined` \| `number`

#### Parameters

| Name | Type |
| :------ | :------ |
| `mimeType` | `string` |

#### Returns

`undefined` \| `number`

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:85](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/media/rtpTransceiver.ts#L85)

___

### setDtlsTransport

▸ **setDtlsTransport**(`dtls`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `dtls` | [`RTCDtlsTransport`](RTCDtlsTransport.md) |

#### Returns

`void`

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:61](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/media/rtpTransceiver.ts#L61)

___

### stop

▸ **stop**(): `void`

#### Returns

`void`

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:77](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/media/rtpTransceiver.ts#L77)

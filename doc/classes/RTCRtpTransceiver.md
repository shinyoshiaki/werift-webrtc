[**werift**](../README.md) • **Docs**

***

[werift](../globals.md) / RTCRtpTransceiver

# Class: RTCRtpTransceiver

## Constructors

### new RTCRtpTransceiver()

> **new RTCRtpTransceiver**(`kind`, `dtlsTransport`, `receiver`, `sender`, `_direction`): [`RTCRtpTransceiver`](RTCRtpTransceiver.md)

#### Parameters

• **kind**: [`Kind`](../type-aliases/Kind.md)

• **dtlsTransport**: [`RTCDtlsTransport`](RTCDtlsTransport.md)

• **receiver**: [`RTCRtpReceiver`](RTCRtpReceiver.md)

• **sender**: [`RTCRtpSender`](RTCRtpSender.md)

• **\_direction**: `"inactive"` \| `"sendonly"` \| `"recvonly"` \| `"sendrecv"`

RFC 8829 4.2.4.  direction the transceiver was initialized with

#### Returns

[`RTCRtpTransceiver`](RTCRtpTransceiver.md)

## Properties

### \_codecs

> **\_codecs**: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[] = `[]`

***

### headerExtensions

> **headerExtensions**: [`RTCRtpHeaderExtensionParameters`](RTCRtpHeaderExtensionParameters.md)[] = `[]`

***

### id

> `readonly` **id**: `string`

***

### kind

> `readonly` **kind**: [`Kind`](../type-aliases/Kind.md)

***

### mLineIndex?

> `optional` **mLineIndex**: `number`

***

### mid?

> `optional` **mid**: `string`

***

### offerDirection

> **offerDirection**: `"inactive"` \| `"sendonly"` \| `"recvonly"` \| `"sendrecv"`

***

### onTrack

> `readonly` **onTrack**: [`Event`](Event.md)\<[[`MediaStreamTrack`](MediaStreamTrack.md), [`RTCRtpTransceiver`](RTCRtpTransceiver.md)]\>

***

### options

> **options**: `Partial`\<[`TransceiverOptions`](../interfaces/TransceiverOptions.md)\> = `{}`

***

### receiver

> **receiver**: [`RTCRtpReceiver`](RTCRtpReceiver.md)

***

### sender

> **sender**: [`RTCRtpSender`](RTCRtpSender.md)

***

### stopped

> **stopped**: `boolean` = `false`

***

### stopping

> **stopping**: `boolean` = `false`

***

### usedForSender

> **usedForSender**: `boolean` = `false`

should not be reused because it has been used for sending before.

## Accessors

### codecs

> `get` **codecs**(): [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[]

> `set` **codecs**(`codecs`): `void`

#### Parameters

• **codecs**: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[]

#### Returns

[`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[]

***

### currentDirection

> `get` **currentDirection**(): `undefined` \| `"inactive"` \| `"sendonly"` \| `"recvonly"` \| `"sendrecv"`

RFC 8829 4.2.5. last negotiated direction

#### Returns

`undefined` \| `"inactive"` \| `"sendonly"` \| `"recvonly"` \| `"sendrecv"`

***

### direction

> `get` **direction**(): `"inactive"` \| `"sendonly"` \| `"recvonly"` \| `"sendrecv"`

RFC 8829 4.2.4. setDirectionに渡された最後の値を示します

#### Returns

`"inactive"` \| `"sendonly"` \| `"recvonly"` \| `"sendrecv"`

***

### dtlsTransport

> `get` **dtlsTransport**(): [`RTCDtlsTransport`](RTCDtlsTransport.md)

#### Returns

[`RTCDtlsTransport`](RTCDtlsTransport.md)

***

### msid

> `get` **msid**(): `string`

#### Returns

`string`

## Methods

### addTrack()

> **addTrack**(`track`): `void`

#### Parameters

• **track**: [`MediaStreamTrack`](MediaStreamTrack.md)

#### Returns

`void`

***

### getPayloadType()

> **getPayloadType**(`mimeType`): `undefined` \| `number`

#### Parameters

• **mimeType**: `string`

#### Returns

`undefined` \| `number`

***

### setCurrentDirection()

> **setCurrentDirection**(`direction`): `void`

#### Parameters

• **direction**: `undefined` \| `"inactive"` \| `"sendonly"` \| `"recvonly"` \| `"sendrecv"`

#### Returns

`void`

***

### setDirection()

> **setDirection**(`direction`): `void`

#### Parameters

• **direction**: `"inactive"` \| `"sendonly"` \| `"recvonly"` \| `"sendrecv"`

#### Returns

`void`

***

### setDtlsTransport()

> **setDtlsTransport**(`dtls`): `void`

#### Parameters

• **dtls**: [`RTCDtlsTransport`](RTCDtlsTransport.md)

#### Returns

`void`

***

### stop()

> **stop**(): `void`

#### Returns

`void`

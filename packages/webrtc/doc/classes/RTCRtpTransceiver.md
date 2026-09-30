[**werift**](../README.md)

***

[werift](../globals.md) / RTCRtpTransceiver

# Class: RTCRtpTransceiver

## Constructors

### new RTCRtpTransceiver()

> **new RTCRtpTransceiver**(`kind`, `dtlsTransport`, `receiver`, `sender`, `_direction`): [`RTCRtpTransceiver`](RTCRtpTransceiver.md)

#### Parameters

##### kind

[`Kind`](../type-aliases/Kind.md)

##### dtlsTransport

`undefined` | [`RTCDtlsTransport`](RTCDtlsTransport.md)

##### receiver

[`RTCRtpReceiver`](RTCRtpReceiver.md)

##### sender

[`RTCRtpSender`](RTCRtpSender.md)

##### \_direction

RFC 8829 4.2.4.  direction the transceiver was initialized with

`"inactive"` | `"sendonly"` | `"recvonly"` | `"sendrecv"`

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

### mid

> **mid**: `null` \| `string` = `null`

***

### mLineIndex?

> `optional` **mLineIndex**: `number`

***

### offerDirection

> **offerDirection**: `"inactive"` \| `"sendonly"` \| `"recvonly"` \| `"sendrecv"`

***

### onTrack

> `readonly` **onTrack**: [`Event`](Event.md)\<\[[`MediaStreamTrack`](MediaStreamTrack.md), [`RTCRtpTransceiver`](RTCRtpTransceiver.md)\]\>

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

#### Get Signature

> **get** **codecs**(): [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[]

##### Returns

[`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[]

#### Set Signature

> **set** **codecs**(`codecs`): `void`

##### Parameters

###### codecs

[`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[]

##### Returns

`void`

***

### currentDirection

#### Get Signature

> **get** **currentDirection**(): `null` \| [`CurrentDirection`](../type-aliases/CurrentDirection.md)

RFC 8829 4.2.5. last negotiated direction

##### Returns

`null` \| [`CurrentDirection`](../type-aliases/CurrentDirection.md)

***

### direction

#### Get Signature

> **get** **direction**(): `"inactive"` \| `"sendonly"` \| `"recvonly"` \| `"sendrecv"`

RFC 8829 4.2.4. setDirectionに渡された最後の値を示します

##### Returns

`"inactive"` \| `"sendonly"` \| `"recvonly"` \| `"sendrecv"`

#### Set Signature

> **set** **direction**(`direction`): `void`

##### Parameters

###### direction

`"inactive"` | `"sendonly"` | `"recvonly"` | `"sendrecv"`

##### Returns

`void`

***

### dtlsTransport

#### Get Signature

> **get** **dtlsTransport**(): [`RTCDtlsTransport`](RTCDtlsTransport.md)

##### Returns

[`RTCDtlsTransport`](RTCDtlsTransport.md)

***

### msid

#### Get Signature

> **get** **msid**(): `string`

##### Returns

`string`

***

### msids

#### Get Signature

> **get** **msids**(): `string`[]

##### Returns

`string`[]

## Methods

### addTrack()

> **addTrack**(`track`): `void`

#### Parameters

##### track

[`MediaStreamTrack`](MediaStreamTrack.md)

#### Returns

`void`

***

### collectCodecStats()

> **collectCodecStats**(`timestamp`): [`RTCStats`](../interfaces/RTCStats.md)[]

#### Parameters

##### timestamp

`number`

#### Returns

[`RTCStats`](../interfaces/RTCStats.md)[]

***

### forceStop()

> **forceStop**(): `void`

#### Returns

`void`

***

### getCodecStats()

> **getCodecStats**(): [`RTCStats`](../interfaces/RTCStats.md)[]

#### Returns

[`RTCStats`](../interfaces/RTCStats.md)[]

***

### getPayloadType()

> **getPayloadType**(`mimeType`): `undefined` \| `number`

#### Parameters

##### mimeType

`string`

#### Returns

`undefined` \| `number`

***

### setCurrentDirection()

> **setCurrentDirection**(`direction`): `void`

#### Parameters

##### direction

`undefined` | [`CurrentDirection`](../type-aliases/CurrentDirection.md)

#### Returns

`void`

***

### setDirection()

> **setDirection**(`direction`): `void`

#### Parameters

##### direction

`"inactive"` | `"sendonly"` | `"recvonly"` | `"sendrecv"`

#### Returns

`void`

***

### setDtlsTransport()

> **setDtlsTransport**(`dtls`): `void`

#### Parameters

##### dtls

[`RTCDtlsTransport`](RTCDtlsTransport.md)

#### Returns

`void`

***

### stop()

> **stop**(): `void`

#### Returns

`void`

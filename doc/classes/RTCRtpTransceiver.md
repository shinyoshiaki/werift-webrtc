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

### pendingRejection

> **pendingRejection**: `boolean` = `false`

remote offer の m-line を拒否予定 (answer 未確定)。
確定するまで既存の RTP pipeline / track は維持し、rollback で false に戻す。

***

### receiver

> **receiver**: [`RTCRtpReceiver`](RTCRtpReceiver.md)

***

### rejected

> **rejected**: `boolean` = `false`

共通 codec がない / remote port 0 のため answer で拒否することが確定した。
`inactive` や app の `stop()` とは区別し、確定後は `stopped` も true になる。

***

### sender

> **sender**: [`RTCRtpSender`](RTCRtpSender.md)

***

### stopped

> **stopped**: `boolean` = `false`

port 0 の交渉が確定し、m-line が停止した transceiver

***

### stopping

> **stopping**: `boolean` = `false`

stop() 済み、または停止が確定した transceiver

***

### usedForSender

> **usedForSender**: `boolean` = `false`

should not be reused because it has been used for sending before.

## Accessors

### associated

#### Get Signature

> **get** **associated**(): `boolean`

m-line (MID / index) と関連付け済みか

##### Returns

`boolean`

***

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

https://www.w3.org/TR/webrtc/#dom-rtcrtptransceiver-stop
送受信をただちに止めて資源を解放し、次の自分の offer で port 0 を交渉する。
冪等で、2 回目以降は何もしない。

#### Returns

`void`

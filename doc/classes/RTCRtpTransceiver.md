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

### codecPreferencesNeedResolution

> **codecPreferencesNeedResolution**: `boolean` = `false`

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

### onCodecPreferencesChanged

> `readonly` **onCodecPreferencesChanged**: [`Event`](Event.md)\<\[\]\>

***

### onTrack

> `readonly` **onTrack**: [`Event`](Event.md)\<\[[`MediaStreamTrack`](MediaStreamTrack.md), [`RTCRtpTransceiver`](RTCRtpTransceiver.md)\]\>

***

### options

> **options**: `Partial`\<[`TransceiverOptions`](../interfaces/TransceiverOptions.md)\> = `{}`

***

### pendingLocalOfferCodecs?

> `optional` **pendingLocalOfferCodecs**: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[]

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

### codecPreferences

#### Get Signature

> **get** **codecPreferences**(): `undefined` \| readonly [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[]

##### Returns

`undefined` \| readonly [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[]

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

### heldByApplication

#### Get Signature

> **get** **heldByApplication**(): `boolean`

Internal: the application uses this transceiver (it attached a track or
stopped it), so a rollback keeps it even if a remote offer created it.

##### Returns

`boolean`

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

### markCodecsForResolution()

> **markCodecsForResolution**(): `void`

Internal: an application change makes the next offer / answer resolve
this transceiver's codecs again. The live sender and receiver keep the
committed codecs until a description is committed.

#### Returns

`void`

***

### restoreNegotiationState()

> **restoreNegotiationState**(`state`): `void`

Internal: return to a negotiation baseline taken by `snapshotNegotiationState`.

#### Parameters

##### state

###### applicationStopRevision

`number` = `...`

###### codecChangeRevision

`number` = `...`

###### codecPreferencesNeedResolution

`boolean` = `...`

###### codecs

[`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[] = `...`

###### currentDirection

`null` \| [`CurrentDirection`](../type-aliases/CurrentDirection.md) = `...`

###### dtlsTransport

[`RTCDtlsTransport`](RTCDtlsTransport.md) = `...`

###### firedReceiving

`boolean` = `...`

###### headerExtensions

[`RTCRtpHeaderExtensionParameters`](RTCRtpHeaderExtensionParameters.md)[] = `...`

###### mid

`null` \| `string` = `...`

###### mLineIndex

`undefined` \| `number` = `...`

###### offerDirection

`"inactive"` \| `"sendonly"` \| `"recvonly"` \| `"sendrecv"` = `...`

###### pendingLocalOfferCodecs

`undefined` \| [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[] = `...`

###### pendingRejection

`boolean` = `...`

###### receiver

\{ `receiverTWCC`: `undefined` \| `ReceiverTWCC`; `receiveTables`: \{ `codecs`: \{\}; `ssrcByRtx`: \{\}; `stagedCodecs`: \{\}; `stagedSsrcByRtx`: \{\}; \}; `remoteStreamId`: `undefined` \| `string`; `remoteStreamIds`: `string`[]; `remoteTrackId`: `undefined` \| `string`; `trackByRID`: \{\}; `trackBySSRC`: \{\}; `tracks`: [`MediaStreamTrack`](MediaStreamTrack.md)[]; `unboundTracks`: [`MediaStreamTrack`](MediaStreamTrack.md)[]; \} = `...`

###### receiver.receiverTWCC

`undefined` \| `ReceiverTWCC` = `...`

###### receiver.receiveTables

\{ `codecs`: \{\}; `ssrcByRtx`: \{\}; `stagedCodecs`: \{\}; `stagedSsrcByRtx`: \{\}; \} = `...`

###### receiver.receiveTables.codecs

\{\} = `...`

###### receiver.receiveTables.ssrcByRtx

\{\} = `...`

###### receiver.receiveTables.stagedCodecs

\{\} = `...`

###### receiver.receiveTables.stagedSsrcByRtx

\{\} = `...`

###### receiver.remoteStreamId

`undefined` \| `string` = `...`

###### receiver.remoteStreamIds

`string`[] = `...`

###### receiver.remoteTrackId

`undefined` \| `string` = `...`

###### receiver.trackByRID

\{\} = `...`

###### receiver.trackBySSRC

\{\} = `...`

###### receiver.tracks

[`MediaStreamTrack`](MediaStreamTrack.md)[] = `...`

###### receiver.unboundTracks

[`MediaStreamTrack`](MediaStreamTrack.md)[] = `...`

###### rejected

`boolean` = `...`

###### sender

\{ `cname`: `undefined` \| `string`; `codec`: `undefined` \| [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md); `headerExtensions`: [`RTCRtpHeaderExtensionParameters`](RTCRtpHeaderExtensionParameters.md)[]; `mid`: `undefined` \| `string`; `negotiatedCodecs`: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[]; `proposedPrimaryCodec`: `undefined` \| [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md); `redRedundantPayloadType`: `undefined` \| `number`; `repairedRtpStreamId`: `undefined` \| `string`; `rtpStreamId`: `undefined` \| `string`; `rtxPayloadType`: `undefined` \| `number`; `sendPrimaryCodec`: `undefined` \| [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md); `track`: `null` \| [`MediaStreamTrack`](MediaStreamTrack.md); `trackCodec`: `undefined` \| [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md); \} = `...`

###### sender.cname

`undefined` \| `string` = `...`

###### sender.codec

`undefined` \| [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md) = `...`

###### sender.headerExtensions

[`RTCRtpHeaderExtensionParameters`](RTCRtpHeaderExtensionParameters.md)[] = `...`

###### sender.mid

`undefined` \| `string` = `...`

###### sender.negotiatedCodecs

[`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[] = `...`

###### sender.proposedPrimaryCodec

`undefined` \| [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md) = `...`

###### sender.redRedundantPayloadType

`undefined` \| `number` = `...`

###### sender.repairedRtpStreamId

`undefined` \| `string` = `...`

###### sender.rtpStreamId

`undefined` \| `string` = `...`

###### sender.rtxPayloadType

`undefined` \| `number` = `...`

###### sender.sendPrimaryCodec

`undefined` \| [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md) = `...`

###### sender.track

`null` \| [`MediaStreamTrack`](MediaStreamTrack.md) = `...`

###### sender.trackCodec

`undefined` \| [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md) = `...`

###### stopped

`boolean` = `...`

###### stopping

`boolean` = `...`

#### Returns

`void`

***

### setCodecPreferences()

> **setCodecPreferences**(`codecs`): `void`

#### Parameters

##### codecs

[`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[]

#### Returns

`void`

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

### snapshotNegotiationState()

> **snapshotNegotiationState**(): `object`

Internal: everything a negotiation may change on this transceiver, its
sender and its receiver, for a rollback baseline. Codec preferences are an
application choice and are not part of it.

#### Returns

`object`

##### applicationStopRevision

> **applicationStopRevision**: `number`

##### codecChangeRevision

> **codecChangeRevision**: `number`

##### codecPreferencesNeedResolution

> **codecPreferencesNeedResolution**: `boolean`

##### codecs

> **codecs**: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[]

##### currentDirection

> **currentDirection**: `null` \| [`CurrentDirection`](../type-aliases/CurrentDirection.md)

##### dtlsTransport

> **dtlsTransport**: [`RTCDtlsTransport`](RTCDtlsTransport.md)

##### firedReceiving

> **firedReceiving**: `boolean`

##### headerExtensions

> **headerExtensions**: [`RTCRtpHeaderExtensionParameters`](RTCRtpHeaderExtensionParameters.md)[]

##### mid

> **mid**: `null` \| `string`

##### mLineIndex

> **mLineIndex**: `undefined` \| `number`

##### offerDirection

> **offerDirection**: `"inactive"` \| `"sendonly"` \| `"recvonly"` \| `"sendrecv"`

##### pendingLocalOfferCodecs

> **pendingLocalOfferCodecs**: `undefined` \| [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[]

##### pendingRejection

> **pendingRejection**: `boolean`

##### receiver

> **receiver**: `object`

###### receiver.receiverTWCC

> **receiverTWCC**: `undefined` \| `ReceiverTWCC`

###### receiver.receiveTables

> **receiveTables**: `object`

###### receiver.receiveTables.codecs

> **codecs**: `object`

###### Index Signature

\[`key`: `number`\]: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)

###### receiver.receiveTables.ssrcByRtx

> **ssrcByRtx**: `object`

###### Index Signature

\[`key`: `number`\]: `number`

###### receiver.receiveTables.stagedCodecs

> **stagedCodecs**: `object`

###### Index Signature

\[`key`: `number`\]: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)

###### receiver.receiveTables.stagedSsrcByRtx

> **stagedSsrcByRtx**: `object`

###### Index Signature

\[`key`: `number`\]: `number`

###### receiver.remoteStreamId

> **remoteStreamId**: `undefined` \| `string`

###### receiver.remoteStreamIds

> **remoteStreamIds**: `string`[]

###### receiver.remoteTrackId

> **remoteTrackId**: `undefined` \| `string`

###### receiver.trackByRID

> **trackByRID**: `object`

###### Index Signature

\[`key`: `string`\]: [`MediaStreamTrack`](MediaStreamTrack.md)

###### receiver.trackBySSRC

> **trackBySSRC**: `object`

###### Index Signature

\[`key`: `string`\]: [`MediaStreamTrack`](MediaStreamTrack.md)

###### receiver.tracks

> **tracks**: [`MediaStreamTrack`](MediaStreamTrack.md)[]

###### receiver.unboundTracks

> **unboundTracks**: [`MediaStreamTrack`](MediaStreamTrack.md)[]

##### rejected

> **rejected**: `boolean`

##### sender

> **sender**: `object`

###### sender.cname

> **cname**: `undefined` \| `string`

###### sender.codec

> **codec**: `undefined` \| [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)

###### sender.headerExtensions

> **headerExtensions**: [`RTCRtpHeaderExtensionParameters`](RTCRtpHeaderExtensionParameters.md)[]

###### sender.mid

> **mid**: `undefined` \| `string`

###### sender.negotiatedCodecs

> **negotiatedCodecs**: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[]

###### sender.proposedPrimaryCodec

> **proposedPrimaryCodec**: `undefined` \| [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)

###### sender.redRedundantPayloadType

> **redRedundantPayloadType**: `undefined` \| `number`

###### sender.repairedRtpStreamId

> **repairedRtpStreamId**: `undefined` \| `string`

###### sender.rtpStreamId

> **rtpStreamId**: `undefined` \| `string`

###### sender.rtxPayloadType

> **rtxPayloadType**: `undefined` \| `number`

###### sender.sendPrimaryCodec

> **sendPrimaryCodec**: `undefined` \| [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)

###### sender.track

> **track**: `null` \| [`MediaStreamTrack`](MediaStreamTrack.md)

###### sender.trackCodec

> **trackCodec**: `undefined` \| [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)

##### stopped

> **stopped**: `boolean`

##### stopping

> **stopping**: `boolean`

***

### stop()

> **stop**(): `void`

https://www.w3.org/TR/webrtc/#dom-rtcrtptransceiver-stop
送受信をただちに止めて資源を解放し、次の自分の offer で port 0 を交渉する。
冪等で、2 回目以降は何もしない。

#### Returns

`void`

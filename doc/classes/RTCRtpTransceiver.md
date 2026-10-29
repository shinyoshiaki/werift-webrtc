[**werift**](../README.md)

***

[werift](../globals.md) / RTCRtpTransceiver

# Class: RTCRtpTransceiver

## Constructors

### Constructor

> **new RTCRtpTransceiver**(`kind`, `dtlsTransport`, `receiver`, `sender`, `_direction`): `RTCRtpTransceiver`

#### Parameters

##### kind

[`Kind`](../type-aliases/Kind.md)

##### dtlsTransport

[`RTCDtlsTransport`](RTCDtlsTransport.md) \| `undefined`

##### receiver

[`RTCRtpReceiver`](RTCRtpReceiver.md)

##### sender

[`RTCRtpSender`](RTCRtpSender.md)

##### \_direction

`"inactive"` \| `"sendonly"` \| `"recvonly"` \| `"sendrecv"`

RFC 8829 4.2.4.  direction the transceiver was initialized with

#### Returns

`RTCRtpTransceiver`

## Properties

### \_codecs

> **\_codecs**: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[] = `[]`

***

### codecPreferencesNeedResolution

> **codecPreferencesNeedResolution**: `boolean` = `false`

***

### createdNegotiationState?

> `optional` **createdNegotiationState?**: `object`

Internal: the negotiation state the transceiver was created with, so a
rollback can return one that no description committed to it.

#### applicationStopRevision

> **applicationStopRevision**: `number`

#### codecChangeRevision

> **codecChangeRevision**: `number`

#### codecPreferencesNeedResolution

> **codecPreferencesNeedResolution**: `boolean`

#### codecs

> **codecs**: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[]

#### currentDirection

> **currentDirection**: [`CurrentDirection`](../type-aliases/CurrentDirection.md) \| `null`

#### dtlsTransport

> **dtlsTransport**: [`RTCDtlsTransport`](RTCDtlsTransport.md)

#### firedReceiving

> **firedReceiving**: `boolean`

#### headerExtensions

> **headerExtensions**: [`RTCRtpHeaderExtensionParameters`](RTCRtpHeaderExtensionParameters.md)[]

#### mid

> **mid**: `string` \| `null`

#### mLineIndex

> **mLineIndex**: `number` \| `undefined`

#### offerDirection

> **offerDirection**: `"inactive"` \| `"sendonly"` \| `"recvonly"` \| `"sendrecv"`

#### pendingLocalOfferCodecs

> **pendingLocalOfferCodecs**: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[] \| `undefined`

#### pendingRejection

> **pendingRejection**: `boolean`

#### receiver

> **receiver**: `object`

##### receiver.receiverTWCC

> **receiverTWCC**: `ReceiverTWCC` \| `undefined`

##### receiver.receiveTables

> **receiveTables**: `object`

##### receiver.receiveTables.codecs

> **codecs**: `object`

###### Index Signature

\[`pt`: `number`\]: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)

##### receiver.receiveTables.ssrcByRtx

> **ssrcByRtx**: `object`

###### Index Signature

\[`rtxSsrc`: `number`\]: `number`

##### receiver.receiveTables.stagedCodecs

> **stagedCodecs**: `object`

###### Index Signature

\[`pt`: `number`\]: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)

##### receiver.receiveTables.stagedSsrcByRtx

> **stagedSsrcByRtx**: `object`

###### Index Signature

\[`rtxSsrc`: `number`\]: `number`

##### receiver.remoteStreamId

> **remoteStreamId**: `string` \| `undefined`

##### receiver.remoteStreamIds

> **remoteStreamIds**: `string`[]

##### receiver.remoteTrackId

> **remoteTrackId**: `string` \| `undefined`

##### receiver.trackByRID

> **trackByRID**: `object`

###### Index Signature

\[`rid`: `string`\]: [`MediaStreamTrack`](MediaStreamTrack.md)

##### receiver.trackBySSRC

> **trackBySSRC**: `object`

###### Index Signature

\[`ssrc`: `string`\]: [`MediaStreamTrack`](MediaStreamTrack.md)

##### receiver.tracks

> **tracks**: [`MediaStreamTrack`](MediaStreamTrack.md)[]

##### receiver.unboundTracks

> **unboundTracks**: [`MediaStreamTrack`](MediaStreamTrack.md)[]

#### rejected

> **rejected**: `boolean`

#### sender

> **sender**: `object`

##### sender.cname

> **cname**: `string` \| `undefined`

##### sender.codec

> **codec**: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md) \| `undefined`

##### sender.headerExtensions

> **headerExtensions**: [`RTCRtpHeaderExtensionParameters`](RTCRtpHeaderExtensionParameters.md)[]

##### sender.mid

> **mid**: `string` \| `undefined`

##### sender.negotiatedCodecs

> **negotiatedCodecs**: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[]

##### sender.proposedPrimaryCodec

> **proposedPrimaryCodec**: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md) \| `undefined`

##### sender.redRedundantPayloadType

> **redRedundantPayloadType**: `number` \| `undefined`

##### sender.repairedRtpStreamId

> **repairedRtpStreamId**: `string` \| `undefined`

##### sender.rtpStreamId

> **rtpStreamId**: `string` \| `undefined`

##### sender.rtxPayloadType

> **rtxPayloadType**: `number` \| `undefined`

##### sender.sendPrimaryCodec

> **sendPrimaryCodec**: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md) \| `undefined`

##### sender.track

> **track**: [`MediaStreamTrack`](MediaStreamTrack.md) \| `null`

##### sender.trackCodec

> **trackCodec**: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md) \| `undefined`

#### stopped

> **stopped**: `boolean`

#### stopping

> **stopping**: `boolean`

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

> **mid**: `string` \| `null` = `null`

***

### mLineIndex?

> `optional` **mLineIndex?**: `number`

***

### offerDirection

> **offerDirection**: `"inactive"` \| `"sendonly"` \| `"recvonly"` \| `"sendrecv"`

***

### onCodecPreferencesChanged

> `readonly` **onCodecPreferencesChanged**: [`Event`](Event.md)\<\[\]\>

***

### onTrack

> `readonly` **onTrack**: [`Event`](Event.md)\<\[[`MediaStreamTrack`](MediaStreamTrack.md), `RTCRtpTransceiver`\]\>

***

### options

> **options**: `Partial`\<[`TransceiverOptions`](../interfaces/TransceiverOptions.md)\> = `{}`

***

### pendingLocalOfferCodecs?

> `optional` **pendingLocalOfferCodecs?**: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[]

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

> **get** **codecPreferences**(): readonly [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[] \| `undefined`

##### Returns

readonly [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[] \| `undefined`

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

> **get** **currentDirection**(): [`CurrentDirection`](../type-aliases/CurrentDirection.md) \| `null`

RFC 8829 4.2.5. last negotiated direction

##### Returns

[`CurrentDirection`](../type-aliases/CurrentDirection.md) \| `null`

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

`"inactive"` \| `"sendonly"` \| `"recvonly"` \| `"sendrecv"`

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

Internal: the application sends on this transceiver (its sender has a
track), so a rollback keeps it even if a remote offer created it. As in
develop, only a track counts: stop(), a direction or codec preferences
set on a remote-created transceiver do not keep it.

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

> **getPayloadType**(`mimeType`): `number` \| `undefined`

#### Parameters

##### mimeType

`string`

#### Returns

`number` \| `undefined`

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

[`CurrentDirection`](../type-aliases/CurrentDirection.md) \| `null` = `...`

###### dtlsTransport

[`RTCDtlsTransport`](RTCDtlsTransport.md) = `...`

###### firedReceiving

`boolean` = `...`

###### headerExtensions

[`RTCRtpHeaderExtensionParameters`](RTCRtpHeaderExtensionParameters.md)[] = `...`

###### mid

`string` \| `null` = `...`

###### mLineIndex

`number` \| `undefined` = `...`

###### offerDirection

`"inactive"` \| `"sendonly"` \| `"recvonly"` \| `"sendrecv"` = `...`

###### pendingLocalOfferCodecs

[`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[] \| `undefined` = `...`

###### pendingRejection

`boolean` = `...`

###### receiver

\{ `receiverTWCC`: `ReceiverTWCC` \| `undefined`; `receiveTables`: \{ `codecs`: \{\[`pt`: `number`\]: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md); \}; `ssrcByRtx`: \{\[`rtxSsrc`: `number`\]: `number`; \}; `stagedCodecs`: \{\[`pt`: `number`\]: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md); \}; `stagedSsrcByRtx`: \{\[`rtxSsrc`: `number`\]: `number`; \}; \}; `remoteStreamId`: `string` \| `undefined`; `remoteStreamIds`: `string`[]; `remoteTrackId`: `string` \| `undefined`; `trackByRID`: \{\[`rid`: `string`\]: [`MediaStreamTrack`](MediaStreamTrack.md); \}; `trackBySSRC`: \{\[`ssrc`: `string`\]: [`MediaStreamTrack`](MediaStreamTrack.md); \}; `tracks`: [`MediaStreamTrack`](MediaStreamTrack.md)[]; `unboundTracks`: [`MediaStreamTrack`](MediaStreamTrack.md)[]; \} = `...`

###### receiver.receiverTWCC

`ReceiverTWCC` \| `undefined` = `...`

###### receiver.receiveTables

\{ `codecs`: \{\[`pt`: `number`\]: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md); \}; `ssrcByRtx`: \{\[`rtxSsrc`: `number`\]: `number`; \}; `stagedCodecs`: \{\[`pt`: `number`\]: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md); \}; `stagedSsrcByRtx`: \{\[`rtxSsrc`: `number`\]: `number`; \}; \} = `...`

###### receiver.receiveTables.codecs

\{\[`pt`: `number`\]: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md); \} = `...`

###### receiver.receiveTables.ssrcByRtx

\{\[`rtxSsrc`: `number`\]: `number`; \} = `...`

###### receiver.receiveTables.stagedCodecs

\{\[`pt`: `number`\]: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md); \} = `...`

###### receiver.receiveTables.stagedSsrcByRtx

\{\[`rtxSsrc`: `number`\]: `number`; \} = `...`

###### receiver.remoteStreamId

`string` \| `undefined` = `...`

###### receiver.remoteStreamIds

`string`[] = `...`

###### receiver.remoteTrackId

`string` \| `undefined` = `...`

###### receiver.trackByRID

\{\[`rid`: `string`\]: [`MediaStreamTrack`](MediaStreamTrack.md); \} = `...`

###### receiver.trackBySSRC

\{\[`ssrc`: `string`\]: [`MediaStreamTrack`](MediaStreamTrack.md); \} = `...`

###### receiver.tracks

[`MediaStreamTrack`](MediaStreamTrack.md)[] = `...`

###### receiver.unboundTracks

[`MediaStreamTrack`](MediaStreamTrack.md)[] = `...`

###### rejected

`boolean` = `...`

###### sender

\{ `cname`: `string` \| `undefined`; `codec`: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md) \| `undefined`; `headerExtensions`: [`RTCRtpHeaderExtensionParameters`](RTCRtpHeaderExtensionParameters.md)[]; `mid`: `string` \| `undefined`; `negotiatedCodecs`: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[]; `proposedPrimaryCodec`: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md) \| `undefined`; `redRedundantPayloadType`: `number` \| `undefined`; `repairedRtpStreamId`: `string` \| `undefined`; `rtpStreamId`: `string` \| `undefined`; `rtxPayloadType`: `number` \| `undefined`; `sendPrimaryCodec`: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md) \| `undefined`; `track`: [`MediaStreamTrack`](MediaStreamTrack.md) \| `null`; `trackCodec`: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md) \| `undefined`; \} = `...`

###### sender.cname

`string` \| `undefined` = `...`

###### sender.codec

[`RTCRtpCodecParameters`](RTCRtpCodecParameters.md) \| `undefined` = `...`

###### sender.headerExtensions

[`RTCRtpHeaderExtensionParameters`](RTCRtpHeaderExtensionParameters.md)[] = `...`

###### sender.mid

`string` \| `undefined` = `...`

###### sender.negotiatedCodecs

[`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[] = `...`

###### sender.proposedPrimaryCodec

[`RTCRtpCodecParameters`](RTCRtpCodecParameters.md) \| `undefined` = `...`

###### sender.redRedundantPayloadType

`number` \| `undefined` = `...`

###### sender.repairedRtpStreamId

`string` \| `undefined` = `...`

###### sender.rtpStreamId

`string` \| `undefined` = `...`

###### sender.rtxPayloadType

`number` \| `undefined` = `...`

###### sender.sendPrimaryCodec

[`RTCRtpCodecParameters`](RTCRtpCodecParameters.md) \| `undefined` = `...`

###### sender.track

[`MediaStreamTrack`](MediaStreamTrack.md) \| `null` = `...`

###### sender.trackCodec

[`RTCRtpCodecParameters`](RTCRtpCodecParameters.md) \| `undefined` = `...`

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

[`CurrentDirection`](../type-aliases/CurrentDirection.md) \| `undefined`

#### Returns

`void`

***

### setDirection()

> **setDirection**(`direction`): `void`

#### Parameters

##### direction

`"inactive"` \| `"sendonly"` \| `"recvonly"` \| `"sendrecv"`

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

> **currentDirection**: [`CurrentDirection`](../type-aliases/CurrentDirection.md) \| `null`

##### dtlsTransport

> **dtlsTransport**: [`RTCDtlsTransport`](RTCDtlsTransport.md)

##### firedReceiving

> **firedReceiving**: `boolean`

##### headerExtensions

> **headerExtensions**: [`RTCRtpHeaderExtensionParameters`](RTCRtpHeaderExtensionParameters.md)[]

##### mid

> **mid**: `string` \| `null`

##### mLineIndex

> **mLineIndex**: `number` \| `undefined`

##### offerDirection

> **offerDirection**: `"inactive"` \| `"sendonly"` \| `"recvonly"` \| `"sendrecv"`

##### pendingLocalOfferCodecs

> **pendingLocalOfferCodecs**: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[] \| `undefined`

##### pendingRejection

> **pendingRejection**: `boolean`

##### receiver

> **receiver**: `object`

###### receiver.receiverTWCC

> **receiverTWCC**: `ReceiverTWCC` \| `undefined`

###### receiver.receiveTables

> **receiveTables**: `object`

###### receiver.receiveTables.codecs

> **codecs**: `object`

###### Index Signature

\[`pt`: `number`\]: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)

###### receiver.receiveTables.ssrcByRtx

> **ssrcByRtx**: `object`

###### Index Signature

\[`rtxSsrc`: `number`\]: `number`

###### receiver.receiveTables.stagedCodecs

> **stagedCodecs**: `object`

###### Index Signature

\[`pt`: `number`\]: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)

###### receiver.receiveTables.stagedSsrcByRtx

> **stagedSsrcByRtx**: `object`

###### Index Signature

\[`rtxSsrc`: `number`\]: `number`

###### receiver.remoteStreamId

> **remoteStreamId**: `string` \| `undefined`

###### receiver.remoteStreamIds

> **remoteStreamIds**: `string`[]

###### receiver.remoteTrackId

> **remoteTrackId**: `string` \| `undefined`

###### receiver.trackByRID

> **trackByRID**: `object`

###### Index Signature

\[`rid`: `string`\]: [`MediaStreamTrack`](MediaStreamTrack.md)

###### receiver.trackBySSRC

> **trackBySSRC**: `object`

###### Index Signature

\[`ssrc`: `string`\]: [`MediaStreamTrack`](MediaStreamTrack.md)

###### receiver.tracks

> **tracks**: [`MediaStreamTrack`](MediaStreamTrack.md)[]

###### receiver.unboundTracks

> **unboundTracks**: [`MediaStreamTrack`](MediaStreamTrack.md)[]

##### rejected

> **rejected**: `boolean`

##### sender

> **sender**: `object`

###### sender.cname

> **cname**: `string` \| `undefined`

###### sender.codec

> **codec**: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md) \| `undefined`

###### sender.headerExtensions

> **headerExtensions**: [`RTCRtpHeaderExtensionParameters`](RTCRtpHeaderExtensionParameters.md)[]

###### sender.mid

> **mid**: `string` \| `undefined`

###### sender.negotiatedCodecs

> **negotiatedCodecs**: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[]

###### sender.proposedPrimaryCodec

> **proposedPrimaryCodec**: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md) \| `undefined`

###### sender.redRedundantPayloadType

> **redRedundantPayloadType**: `number` \| `undefined`

###### sender.repairedRtpStreamId

> **repairedRtpStreamId**: `string` \| `undefined`

###### sender.rtpStreamId

> **rtpStreamId**: `string` \| `undefined`

###### sender.rtxPayloadType

> **rtxPayloadType**: `number` \| `undefined`

###### sender.sendPrimaryCodec

> **sendPrimaryCodec**: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md) \| `undefined`

###### sender.track

> **track**: [`MediaStreamTrack`](MediaStreamTrack.md) \| `null`

###### sender.trackCodec

> **trackCodec**: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md) \| `undefined`

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

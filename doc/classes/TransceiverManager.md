[**werift**](../README.md)

***

[werift](../globals.md) / TransceiverManager

# Class: TransceiverManager

## Constructors

### new TransceiverManager()

> **new TransceiverManager**(`cname`, `config`, `router`): [`TransceiverManager`](TransceiverManager.md)

#### Parameters

##### cname

`string`

##### config

`Required`\<[`PeerConfig`](../interfaces/PeerConfig.md)\>

##### router

[`RtpRouter`](RtpRouter.md)

#### Returns

[`TransceiverManager`](TransceiverManager.md)

## Properties

### onNegotiationNeeded

> `readonly` **onNegotiationNeeded**: [`Event`](Event.md)\<\[\]\>

***

### onRemoteTransceiverAdded

> `readonly` **onRemoteTransceiverAdded**: [`Event`](Event.md)\<\[[`RTCRtpTransceiver`](RTCRtpTransceiver.md)\]\>

***

### onTrack

> `readonly` **onTrack**: [`Event`](Event.md)\<\[\{ `streams`: [`MediaStream`](MediaStream.md)[]; `track`: [`MediaStreamTrack`](MediaStreamTrack.md); `transceiver`: [`RTCRtpTransceiver`](RTCRtpTransceiver.md); \}\]\>

***

### onTransceiverAdded

> `readonly` **onTransceiverAdded**: [`Event`](Event.md)\<\[[`RTCRtpTransceiver`](RTCRtpTransceiver.md)\]\>

## Methods

### addTrack()

> **addTrack**(`track`, `streams`): [`RTCRtpTransceiver`](RTCRtpTransceiver.md)

#### Parameters

##### track

[`MediaStreamTrack`](MediaStreamTrack.md)

##### streams

[`MediaStream`](MediaStream.md)[] = `[]`

#### Returns

[`RTCRtpTransceiver`](RTCRtpTransceiver.md)

***

### addTransceiver()

> **addTransceiver**(`trackOrKind`, `dtlsTransport`?, `options`?, `__namedParameters`?): [`RTCRtpTransceiver`](RTCRtpTransceiver.md)

#### Parameters

##### trackOrKind

[`Kind`](../type-aliases/Kind.md) | [`MediaStreamTrack`](MediaStreamTrack.md)

##### dtlsTransport?

[`RTCDtlsTransport`](RTCDtlsTransport.md)

##### options?

`Partial`\<[`TransceiverOptions`](../interfaces/TransceiverOptions.md)\> = `{}`

##### \_\_namedParameters?

###### remoteMLineIndex?

`number`

remote offer 起因で作る場合の m-line index。確定済み停止位置の自動再利用は行わない

#### Returns

[`RTCRtpTransceiver`](RTCRtpTransceiver.md)

***

### assignTransceiverCodecs()

> **assignTransceiverCodecs**(`transceiver`): `void`

#### Parameters

##### transceiver

[`RTCRtpTransceiver`](RTCRtpTransceiver.md)

#### Returns

`void`

***

### associateMLine()

> **associateMLine**(`transceiver`, `mLineIndex`): `void`

既存の未関連付け transceiver を remote m-line の位置に関連付ける。
同じ位置に停止済みの旧 transceiver があれば m-line から外し、配列上でも置き換える。
(旧 transceiver が位置を持ったままだと MID の割り当て先が重複する)

#### Parameters

##### transceiver

[`RTCRtpTransceiver`](RTCRtpTransceiver.md)

##### mLineIndex

`number`

#### Returns

`void`

***

### close()

> **close**(): `void`

全トランシーバーのreceiver/senderのstopを呼ぶcloseメソッド

#### Returns

`void`

***

### collectStats()

> **collectStats**(`timestamp`): [`RTCStats`](../interfaces/RTCStats.md)[]

#### Parameters

##### timestamp

`number`

#### Returns

[`RTCStats`](../interfaces/RTCStats.md)[]

***

### commitAnswerCodecs()

> **commitAnswerCodecs**(`transceiver`, `remoteMedia`): `void`

Commit an answer's refreshed codec proposal to sender and receiver state.

#### Parameters

##### transceiver

[`RTCRtpTransceiver`](RTCRtpTransceiver.md)

##### remoteMedia

[`MediaDescription`](MediaDescription.md)

#### Returns

`void`

***

### commitRemoteOffer()

> **commitRemoteOffer**(): `void`

local answer の確定で、拒否予定の m-line を停止・解放する。
remote SDP 起因の停止なので negotiationneeded は要求しない。

#### Returns

`void`

***

### getLocalRtpParams()

> **getLocalRtpParams**(`transceiver`): [`RTCRtpParameters`](../interfaces/RTCRtpParameters.md)

#### Parameters

##### transceiver

[`RTCRtpTransceiver`](RTCRtpTransceiver.md)

#### Returns

[`RTCRtpParameters`](../interfaces/RTCRtpParameters.md)

***

### getReceivers()

> **getReceivers**(): [`RTCRtpReceiver`](RTCRtpReceiver.md)[]

#### Returns

[`RTCRtpReceiver`](RTCRtpReceiver.md)[]

***

### getRemoteRtpParams()

> **getRemoteRtpParams**(`media`, `transceiver`): [`RTCRtpReceiveParameters`](../interfaces/RTCRtpReceiveParameters.md)

#### Parameters

##### media

[`MediaDescription`](MediaDescription.md)

##### transceiver

[`RTCRtpTransceiver`](RTCRtpTransceiver.md)

#### Returns

[`RTCRtpReceiveParameters`](../interfaces/RTCRtpReceiveParameters.md)

***

### getSenders()

> **getSenders**(): [`RTCRtpSender`](RTCRtpSender.md)[]

#### Returns

[`RTCRtpSender`](RTCRtpSender.md)[]

***

### getStatsRootIds()

> **getStatsRootIds**(`selector`): `string`[]

#### Parameters

##### selector

`undefined` | `null` | [`MediaStreamTrack`](MediaStreamTrack.md)

#### Returns

`string`[]

***

### getTransceiverByMLineIndex()

> **getTransceiverByMLineIndex**(`index`): `undefined` \| [`RTCRtpTransceiver`](RTCRtpTransceiver.md)

#### Parameters

##### index

`number`

#### Returns

`undefined` \| [`RTCRtpTransceiver`](RTCRtpTransceiver.md)

***

### getTransceivers()

> **getTransceivers**(): [`RTCRtpTransceiver`](RTCRtpTransceiver.md)[]

#### Returns

[`RTCRtpTransceiver`](RTCRtpTransceiver.md)[]

***

### planRemoteRtpCodecs()

> **planRemoteRtpCodecs**(`remoteSdp`, `findTransceiver`): `Map`\<`number`, [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[]\>

remote SDP の全 audio/video m-line の codec を副作用なしで解決する。
transceiver の対応付けは本適用と同じ resolver を使い、検証と適用の判定をずらさない。
- port 0、停止済み / 停止中の m-line は codec 解決をしない (空)
- local capability と MIME が 1 つも一致しない m-line は空とし、
  offer は setRemoteRTP() で拒否 (port 0 answer)、answer/pranswer は
  SDPManager が InvalidAccessError とする (Issue #705)
- source constraint / preference / pending offer との不一致は NotSupportedError

#### Parameters

##### remoteSdp

[`SessionDescription`](SessionDescription.md)

##### findTransceiver

(`remoteMedia`, `index`) => `undefined` \| [`RTCRtpTransceiver`](RTCRtpTransceiver.md)

#### Returns

`Map`\<`number`, [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[]\>

***

### pushTransceiver()

> **pushTransceiver**(`t`): `void`

#### Parameters

##### t

[`RTCRtpTransceiver`](RTCRtpTransceiver.md)

#### Returns

`void`

***

### refreshAnswerCodecs()

> **refreshAnswerCodecs**(`transceiver`, `remoteMedia`): `void`

#### Parameters

##### transceiver

[`RTCRtpTransceiver`](RTCRtpTransceiver.md)

##### remoteMedia

[`MediaDescription`](MediaDescription.md)

#### Returns

`void`

***

### releaseUnassociatedReservations()

> **releaseUnassociatedReservations**(`associated`, `mLineCount`): `void`

remote offer が定義した位置のうち、関連付けられなかった未交渉 transceiver の予約を解除する。
(remote が予約位置を別 kind や別 transceiver で再利用した場合、次の offer で末尾に追加させる)

#### Parameters

##### associated

`Set`\<[`RTCRtpTransceiver`](RTCRtpTransceiver.md)\>

##### mLineCount

`number`

#### Returns

`void`

***

### removeTrack()

> **removeTrack**(`sender`): `boolean`

sender から track を外す。

#### Parameters

##### sender

[`RTCRtpSender`](RTCRtpSender.md)

#### Returns

`boolean`

交渉が必要な変更をした場合 true (呼び出し側が negotiationneeded を要求する)

***

### replaceTransceiver()

> **replaceTransceiver**(`t`, `index`): `void`

#### Parameters

##### t

[`RTCRtpTransceiver`](RTCRtpTransceiver.md)

##### index

`number`

#### Returns

`void`

***

### restoreNegotiationState()

> **restoreNegotiationState**(`snapshot`, `added`, `createdState`, `carried`): [`RTCDtlsTransport`](RTCDtlsTransport.md)[]

Internal: return to a negotiation baseline. Transceivers in `added` were
created by the rolled-back proposal: they are removed unless the
application uses them, in which case only their m-line association goes.

#### Parameters

##### snapshot

`TransceiversNegotiationState`

##### added

`Iterable`\<[`RTCRtpTransceiver`](RTCRtpTransceiver.md)\>

##### createdState

(`transceiver`) => `undefined` \| \{ `applicationStopRevision`: `number`; `codecChangeRevision`: `number`; `codecPreferencesNeedResolution`: `boolean`; `codecs`: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[]; `currentDirection`: `null` \| [`CurrentDirection`](../type-aliases/CurrentDirection.md); `dtlsTransport`: [`RTCDtlsTransport`](RTCDtlsTransport.md); `firedReceiving`: `boolean`; `headerExtensions`: [`RTCRtpHeaderExtensionParameters`](RTCRtpHeaderExtensionParameters.md)[]; `mid`: `null` \| `string`; `mLineIndex`: `undefined` \| `number`; `offerDirection`: `"inactive"` \| `"sendonly"` \| `"recvonly"` \| `"sendrecv"`; `pendingLocalOfferCodecs`: `undefined` \| [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[]; `pendingRejection`: `boolean`; `receiver`: \{ `receiverTWCC`: `undefined` \| `ReceiverTWCC`; `receiveTables`: \{ `codecs`: \{\}; `ssrcByRtx`: \{\}; `stagedCodecs`: \{\}; `stagedSsrcByRtx`: \{\}; \}; `remoteStreamId`: `undefined` \| `string`; `remoteStreamIds`: `string`[]; `remoteTrackId`: `undefined` \| `string`; `trackByRID`: \{\}; `trackBySSRC`: \{\}; `tracks`: [`MediaStreamTrack`](MediaStreamTrack.md)[]; `unboundTracks`: [`MediaStreamTrack`](MediaStreamTrack.md)[]; \}; `rejected`: `boolean`; `sender`: \{ `cname`: `undefined` \| `string`; `codec`: `undefined` \| [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md); `headerExtensions`: [`RTCRtpHeaderExtensionParameters`](RTCRtpHeaderExtensionParameters.md)[]; `mid`: `undefined` \| `string`; `negotiatedCodecs`: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[]; `proposedPrimaryCodec`: `undefined` \| [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md); `redRedundantPayloadType`: `undefined` \| `number`; `repairedRtpStreamId`: `undefined` \| `string`; `rtpStreamId`: `undefined` \| `string`; `rtxPayloadType`: `undefined` \| `number`; `sendPrimaryCodec`: `undefined` \| [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md); `track`: `null` \| [`MediaStreamTrack`](MediaStreamTrack.md); `trackCodec`: `undefined` \| [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md); \}; `stopped`: `boolean`; `stopping`: `boolean`; \}

##### carried

`ReadonlySet`\<[`RTCRtpTransceiver`](RTCRtpTransceiver.md)\> = `...`

#### Returns

[`RTCDtlsTransport`](RTCDtlsTransport.md)[]

transports of the removed transceivers (the caller stops unused ones)

***

### revertUnappliedAssociations()

> **revertUnappliedAssociations**(`snapshot`): `void`

Internal: a created offer that was never applied must not leave its MID
and m-line assignments behind (W3C associates a MID only when a
description is set). Transceivers the session never negotiated go back to
`snapshot`.

#### Parameters

##### snapshot

`TransceiversNegotiationState`

#### Returns

`void`

***

### setRemoteRTP()

> **setRemoteRTP**(`transceiver`, `remoteMedia`, `type`, `mLineIndex`, `codecs`): `boolean`

remote m-line を transceiver に適用する。
codecs は planRemoteRtpCodecs() で検証済みの解決結果を渡す。
codec が空、または remote port 0 の m-line は拒否として扱い、
sender/receiver 準備・router 登録・onTrack・TWCC を行わない。

#### Parameters

##### transceiver

[`RTCRtpTransceiver`](RTCRtpTransceiver.md)

##### remoteMedia

[`MediaDescription`](MediaDescription.md)

##### type

`"offer"` | `"answer"` | `"pranswer"`

##### mLineIndex

`number`

##### codecs

[`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[]

#### Returns

`boolean`

受け入れた (RTP を流す) 場合 true

***

### settleStoppingTransceivers()

> **settleStoppingTransceivers**(`negotiatedMids`): `boolean`

answer 確定後に、stopping のまま交渉対象になり得ない transceiver の停止を確定する。
(MID が確定済み local description の非ゼロ m-line にない = offer から外れる)

#### Parameters

##### negotiatedMids

`Set`\<`string`\>

確定済み local description の非ゼロ port の MID

#### Returns

`boolean`

次の自分の offer で port 0 を交渉すべき transceiver があるか

***

### snapshotNegotiationState()

> **snapshotNegotiationState**(): `TransceiversNegotiationState`

Internal: the transceivers, their order and negotiation state, for a rollback baseline.

#### Returns

`TransceiversNegotiationState`

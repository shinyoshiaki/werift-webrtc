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

> **addTransceiver**(`trackOrKind`, `dtlsTransport`?, `options`?): [`RTCRtpTransceiver`](RTCRtpTransceiver.md)

#### Parameters

##### trackOrKind

[`Kind`](../type-aliases/Kind.md) | [`MediaStreamTrack`](MediaStreamTrack.md)

##### dtlsTransport?

[`RTCDtlsTransport`](RTCDtlsTransport.md)

##### options?

`Partial`\<[`TransceiverOptions`](../interfaces/TransceiverOptions.md)\> = `{}`

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

### pushTransceiver()

> **pushTransceiver**(`t`): `void`

#### Parameters

##### t

[`RTCRtpTransceiver`](RTCRtpTransceiver.md)

#### Returns

`void`

***

### removeTrack()

> **removeTrack**(`sender`): `void`

#### Parameters

##### sender

[`RTCRtpSender`](RTCRtpSender.md)

#### Returns

`void`

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

### restoreRouterTables()

> **restoreRouterTables**(`snapshot`): `void`

#### Parameters

##### snapshot

[`RouterTableSnapshot`](../interfaces/RouterTableSnapshot.md)

#### Returns

`void`

***

### restoreTransceiverMedia()

> **restoreTransceiverMedia**(`snapshot`): `void`

#### Parameters

##### snapshot

[`TransceiverMediaSnapshot`](../interfaces/TransceiverMediaSnapshot.md)[]

#### Returns

`void`

***

### runWithoutNegotiationNeeded()

> **runWithoutNegotiationNeeded**\<`T`\>(`fn`): `T`

内部確定処理を negotiationneeded なしで実行する。protocol-driven な
rejection 適用 (remote SDP 由来の stop/finalize) では、新しい local
negotiation を要求しない。application の明示的 stop とは別経路にする。

#### Type Parameters

• **T**

#### Parameters

##### fn

() => `T`

#### Returns

`T`

***

### setRemoteRTP()

> **setRemoteRTP**(`transceiver`, `remoteMedia`, `type`, `mLineIndex`): `void`

#### Parameters

##### transceiver

[`RTCRtpTransceiver`](RTCRtpTransceiver.md)

##### remoteMedia

[`MediaDescription`](MediaDescription.md)

##### type

`"offer"` | `"answer"` | `"pranswer"`

##### mLineIndex

`number`

#### Returns

`void`

***

### snapshotRouterTables()

> **snapshotRouterTables**(): [`RouterTableSnapshot`](../interfaces/RouterTableSnapshot.md)

#### Returns

[`RouterTableSnapshot`](../interfaces/RouterTableSnapshot.md)

***

### snapshotTransceiverMedia()

> **snapshotTransceiverMedia**(): [`TransceiverMediaSnapshot`](../interfaces/TransceiverMediaSnapshot.md)[]

remote offer/pranswer 適用前の transceiver media 状態の snapshot。
rollback 時に復元し、pending だった codec/rejection/direction 変更を
current session へ漏らさないようにする。

#### Returns

[`TransceiverMediaSnapshot`](../interfaces/TransceiverMediaSnapshot.md)[]

***

### validateAnswerCodecs()

> **validateAnswerCodecs**(`remoteSdp`, `localOffer`): `void`

remote answer/pranswer の commit 前検証。non-zero の audio/video m-line は
pending local offer と共通 codec が必要。offer 側の「unsupported は answer
で reject」を answer 側に広げず、無効な answer は状態変更前に失敗させる。
remote port 0 は通常どおり受理する。

#### Parameters

##### remoteSdp

[`SessionDescription`](SessionDescription.md)

##### localOffer

`undefined` | [`SessionDescription`](SessionDescription.md)

#### Returns

`void`

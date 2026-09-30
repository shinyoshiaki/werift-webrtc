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

### getNotifiedRemoteTrack()

> **getNotifiedRemoteTrack**(`transceiver`): `undefined` \| \{ `streams`: `string`[]; `track`: [`MediaStreamTrack`](MediaStreamTrack.md); \}

#### Parameters

##### transceiver

[`RTCRtpTransceiver`](RTCRtpTransceiver.md)

#### Returns

`undefined` \| \{ `streams`: `string`[]; `track`: [`MediaStreamTrack`](MediaStreamTrack.md); \}

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

### negotiateCodecs()

> **negotiateCodecs**(`remoteMedia`): [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[]

remote m-line の codec と local 設定の共通部分を返す

#### Parameters

##### remoteMedia

[`MediaDescription`](MediaDescription.md)

#### Returns

[`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[]

***

### pushTransceiver()

> **pushTransceiver**(`t`): `void`

#### Parameters

##### t

[`RTCRtpTransceiver`](RTCRtpTransceiver.md)

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

### removeRemoteTransceiver()

> **removeRemoteTransceiver**(`transceiver`): `void`

Remove an uncommitted transceiver created only by a remote offer.

#### Parameters

##### transceiver

[`RTCRtpTransceiver`](RTCRtpTransceiver.md)

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

### restoreNotifiedRemoteTrack()

> **restoreNotifiedRemoteTrack**(`transceiver`, `state`): `void`

#### Parameters

##### transceiver

[`RTCRtpTransceiver`](RTCRtpTransceiver.md)

##### state

`undefined` | \{ `streams`: `string`[]; `track`: [`MediaStreamTrack`](MediaStreamTrack.md); \}

#### Returns

`void`

***

### restoreTransceiverOrder()

> **restoreTransceiverOrder**(`baseline`): `void`

#### Parameters

##### baseline

[`RTCRtpTransceiver`](RTCRtpTransceiver.md)[]

#### Returns

`void`

***

### setRemoteRTP()

> **setRemoteRTP**(`transceiver`, `remoteMedia`, `type`, `mLineIndex`): `boolean`

remote m-line を適用する。拒否された m-line なら false を返す

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

`boolean`

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

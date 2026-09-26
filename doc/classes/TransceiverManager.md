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

### beginRemoteOffer()

> **beginRemoteOffer**(): `void`

remote offer 適用前の transceiver 対応を保存する。
同じ offer/answer 交換中に複数回呼ばれても最初の状態を保持する。

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

### rollbackRemoteOffer()

> **rollbackRemoteOffer**(): `void`

remote offer の rollback で transceiver 対応を元に戻す

#### Returns

`void`

***

### setRemoteRTP()

> **setRemoteRTP**(`transceiver`, `remoteMedia`, `type`, `mLineIndex`): `boolean`

remote m-line を transceiver に適用する。
共通 codec がない、または remote port 0 の m-line は拒否として扱い、
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

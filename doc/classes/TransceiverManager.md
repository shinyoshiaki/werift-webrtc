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

> `readonly` **onTrack**: [`Event`](Event.md)\<\[\{ `stream`: [`MediaStream`](MediaStream.md); `track`: [`MediaStreamTrack`](MediaStreamTrack.md); `transceiver`: [`RTCRtpTransceiver`](RTCRtpTransceiver.md); \}\]\>

***

### onTransceiverAdded

> `readonly` **onTransceiverAdded**: [`Event`](Event.md)\<\[[`RTCRtpTransceiver`](RTCRtpTransceiver.md)\]\>

## Methods

### addTrack()

> **addTrack**(`track`, `ms`?): [`RTCRtpTransceiver`](RTCRtpTransceiver.md)

#### Parameters

##### track

[`MediaStreamTrack`](MediaStreamTrack.md)

##### ms?

[`MediaStream`](MediaStream.md)

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

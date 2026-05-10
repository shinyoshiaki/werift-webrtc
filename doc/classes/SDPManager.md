[**werift**](../README.md)

***

[werift](../globals.md) / SDPManager

# Class: SDPManager

## Constructors

### new SDPManager()

> **new SDPManager**(`__namedParameters`): [`SDPManager`](SDPManager.md)

#### Parameters

##### \_\_namedParameters

###### bundlePolicy?

[`BundlePolicy`](../type-aliases/BundlePolicy.md)

###### cname

`string`

###### midSuffix?

`boolean`

#### Returns

[`SDPManager`](SDPManager.md)

## Properties

### bundlePolicy?

> `readonly` `optional` **bundlePolicy**: [`BundlePolicy`](../type-aliases/BundlePolicy.md)

***

### cname

> `readonly` **cname**: `string`

***

### currentLocalDescription?

> `optional` **currentLocalDescription**: [`SessionDescription`](SessionDescription.md)

***

### currentRemoteDescription?

> `optional` **currentRemoteDescription**: [`SessionDescription`](SessionDescription.md)

***

### midSuffix

> `readonly` **midSuffix**: `boolean`

***

### pendingLocalDescription?

> `optional` **pendingLocalDescription**: [`SessionDescription`](SessionDescription.md)

***

### pendingRemoteDescription?

> `optional` **pendingRemoteDescription**: [`SessionDescription`](SessionDescription.md)

## Accessors

### inactiveRemoteMedia

#### Get Signature

> **get** **inactiveRemoteMedia**(): `undefined` \| [`MediaDescription`](MediaDescription.md)

##### Returns

`undefined` \| [`MediaDescription`](MediaDescription.md)

***

### localDescription

#### Get Signature

> **get** **localDescription**(): `undefined` \| [`RTCSessionDescription`](RTCSessionDescription.md)

##### Returns

`undefined` \| [`RTCSessionDescription`](RTCSessionDescription.md)

***

### remoteDescription

#### Get Signature

> **get** **remoteDescription**(): `undefined` \| [`RTCSessionDescription`](RTCSessionDescription.md)

##### Returns

`undefined` \| [`RTCSessionDescription`](RTCSessionDescription.md)

***

### remoteIsBundled

#### Get Signature

> **get** **remoteIsBundled**(): `undefined` \| [`GroupDescription`](GroupDescription.md)

##### Returns

`undefined` \| [`GroupDescription`](GroupDescription.md)

## Methods

### addTransportDescription()

> **addTransportDescription**(`media`, `dtlsTransport`): `void`

トランスポートの情報をMediaDescriptionに追加

#### Parameters

##### media

[`MediaDescription`](MediaDescription.md)

##### dtlsTransport

[`RTCDtlsTransport`](RTCDtlsTransport.md)

#### Returns

`void`

***

### allocateMid()

> **allocateMid**(`type`): `string`

一意のMIDを割り当て

#### Parameters

##### type

`""` | `"dc"` | `"av"`

#### Returns

`string`

***

### buildAnswerSdp()

> **buildAnswerSdp**(`__namedParameters`): [`SessionDescription`](SessionDescription.md)

アンサーSDPを構築

#### Parameters

##### \_\_namedParameters

###### sctpTransport

`undefined` \| [`RTCSctpTransport`](RTCSctpTransport.md)

###### signalingState

`string`

###### transceivers

[`RTCRtpTransceiver`](RTCRtpTransceiver.md)[]

#### Returns

[`SessionDescription`](SessionDescription.md)

***

### buildOfferSdp()

> **buildOfferSdp**(`transceivers`, `sctpTransport`): [`SessionDescription`](SessionDescription.md)

オファーSDPを構築

#### Parameters

##### transceivers

[`RTCRtpTransceiver`](RTCRtpTransceiver.md)[]

##### sctpTransport

`undefined` | [`RTCSctpTransport`](RTCSctpTransport.md)

#### Returns

[`SessionDescription`](SessionDescription.md)

***

### createMediaDescriptionForSctp()

> **createMediaDescriptionForSctp**(`sctp`): [`MediaDescription`](MediaDescription.md)

MediaDescriptionをSCTP用に作成

#### Parameters

##### sctp

[`RTCSctpTransport`](RTCSctpTransport.md)

#### Returns

[`MediaDescription`](MediaDescription.md)

***

### createMediaDescriptionForTransceiver()

> **createMediaDescriptionForTransceiver**(`transceiver`, `direction`): [`MediaDescription`](MediaDescription.md)

MediaDescriptionをトランシーバー用に作成

#### Parameters

##### transceiver

[`RTCRtpTransceiver`](RTCRtpTransceiver.md)

##### direction

`"inactive"` | `"sendonly"` | `"recvonly"` | `"sendrecv"`

#### Returns

[`MediaDescription`](MediaDescription.md)

***

### parseSdp()

> **parseSdp**(`__namedParameters`): [`SessionDescription`](SessionDescription.md)

#### Parameters

##### \_\_namedParameters

###### isLocal

`boolean`

###### sdp

`string`

###### signalingState

`string`

###### type

`"offer"` \| `"answer"` \| `"pranswer"`

#### Returns

[`SessionDescription`](SessionDescription.md)

***

### registerMid()

> **registerMid**(`mid`): `void`

#### Parameters

##### mid

`string`

#### Returns

`void`

***

### rollbackLocalDescription()

> **rollbackLocalDescription**(`signalingState`): `void`

#### Parameters

##### signalingState

`string`

#### Returns

`void`

***

### setLocal()

> **setLocal**(`description`, `transceivers`, `sctpTransport`?): `void`

ローカルセッション記述を設定し、トランスポート情報を追加する

#### Parameters

##### description

[`SessionDescription`](SessionDescription.md)

##### transceivers

[`RTCRtpTransceiver`](RTCRtpTransceiver.md)[]

##### sctpTransport?

###### dtlsTransport

[`RTCDtlsTransport`](RTCDtlsTransport.md)

###### mid?

`string`

#### Returns

`void`

***

### setLocalDescription()

> **setLocalDescription**(`description`): `void`

#### Parameters

##### description

[`SessionDescription`](SessionDescription.md)

#### Returns

`void`

***

### setRemoteDescription()

> **setRemoteDescription**(`sessionDescription`, `signalingState`): `undefined` \| [`SessionDescription`](SessionDescription.md)

#### Parameters

##### sessionDescription

[`RTCSessionDescriptionInit`](../interfaces/RTCSessionDescriptionInit.md)

##### signalingState

`string`

#### Returns

`undefined` \| [`SessionDescription`](SessionDescription.md)

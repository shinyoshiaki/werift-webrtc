[werift](../README.md) / [Exports](../modules.md) / RTCRtpReceiver

# Class: RTCRtpReceiver

## Table of contents

### Constructors

- [constructor](RTCRtpReceiver.md#constructor)

### Properties

- [config](RTCRtpReceiver.md#config)
- [dtlsTransport](RTCRtpReceiver.md#dtlstransport)
- [kind](RTCRtpReceiver.md#kind)
- [lastSRtimestamp](RTCRtpReceiver.md#lastsrtimestamp)
- [latestRepairedRid](RTCRtpReceiver.md#latestrepairedrid)
- [latestRid](RTCRtpReceiver.md#latestrid)
- [onPacketLost](RTCRtpReceiver.md#onpacketlost)
- [onRtcp](RTCRtpReceiver.md#onrtcp)
- [receiveLastSRTimestamp](RTCRtpReceiver.md#receivelastsrtimestamp)
- [receiverTWCC](RTCRtpReceiver.md#receivertwcc)
- [remoteStreamId](RTCRtpReceiver.md#remotestreamid)
- [remoteTrackId](RTCRtpReceiver.md#remotetrackid)
- [rtcpRunning](RTCRtpReceiver.md#rtcprunning)
- [rtcpSsrc](RTCRtpReceiver.md#rtcpssrc)
- [sdesMid](RTCRtpReceiver.md#sdesmid)
- [stopped](RTCRtpReceiver.md#stopped)
- [trackByRID](RTCRtpReceiver.md#trackbyrid)
- [trackBySSRC](RTCRtpReceiver.md#trackbyssrc)
- [tracks](RTCRtpReceiver.md#tracks)
- [type](RTCRtpReceiver.md#type)
- [uuid](RTCRtpReceiver.md#uuid)

### Accessors

- [nackEnabled](RTCRtpReceiver.md#nackenabled)
- [pliEnabled](RTCRtpReceiver.md#plienabled)
- [track](RTCRtpReceiver.md#track)
- [twccEnabled](RTCRtpReceiver.md#twccenabled)

### Methods

- [addTrack](RTCRtpReceiver.md#addtrack)
- [getStats](RTCRtpReceiver.md#getstats)
- [handleRtcpPacket](RTCRtpReceiver.md#handlertcppacket)
- [handleRtpByRid](RTCRtpReceiver.md#handlertpbyrid)
- [handleRtpBySsrc](RTCRtpReceiver.md#handlertpbyssrc)
- [prepareReceive](RTCRtpReceiver.md#preparereceive)
- [runRtcp](RTCRtpReceiver.md#runrtcp)
- [sendRtcpPLI](RTCRtpReceiver.md#sendrtcppli)
- [setDtlsTransport](RTCRtpReceiver.md#setdtlstransport)
- [setupTWCC](RTCRtpReceiver.md#setuptwcc)
- [stop](RTCRtpReceiver.md#stop)

## Constructors

### constructor

• **new RTCRtpReceiver**(`config`, `kind`, `rtcpSsrc`): [`RTCRtpReceiver`](RTCRtpReceiver.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `config` | [`PeerConfig`](../interfaces/PeerConfig.md) |
| `kind` | [`Kind`](../modules.md#kind) |
| `rtcpSsrc` | `number` |

#### Returns

[`RTCRtpReceiver`](RTCRtpReceiver.md)

## Properties

### config

• `Readonly` **config**: [`PeerConfig`](../interfaces/PeerConfig.md)

___

### dtlsTransport

• **dtlsTransport**: [`RTCDtlsTransport`](RTCDtlsTransport.md)

___

### kind

• **kind**: [`Kind`](../modules.md#kind)

___

### lastSRtimestamp

• `Readonly` **lastSRtimestamp**: `Object` = `{}`

last sender Report Timestamp
compactNtp

#### Index signature

▪ [ssrc: `number`]: `number`

___

### latestRepairedRid

• `Optional` **latestRepairedRid**: `string`

___

### latestRid

• `Optional` **latestRid**: `string`

___

### onPacketLost

• `Readonly` **onPacketLost**: `Event`\<[[`GenericNack`](GenericNack.md)]\>

___

### onRtcp

• `Readonly` **onRtcp**: `Event`\<[[`RtcpPacket`](../modules.md#rtcppacket)]\>

___

### receiveLastSRTimestamp

• `Readonly` **receiveLastSRTimestamp**: `Object` = `{}`

seconds

#### Index signature

▪ [ssrc: `number`]: `number`

___

### receiverTWCC

• `Optional` **receiverTWCC**: `ReceiverTWCC`

___

### remoteStreamId

• `Optional` **remoteStreamId**: `string`

___

### remoteTrackId

• `Optional` **remoteTrackId**: `string`

___

### rtcpRunning

• **rtcpRunning**: `boolean` = `false`

___

### rtcpSsrc

• **rtcpSsrc**: `number`

___

### sdesMid

• `Optional` **sdesMid**: `string`

___

### stopped

• **stopped**: `boolean` = `false`

___

### trackByRID

• `Readonly` **trackByRID**: `Object` = `{}`

#### Index signature

▪ [rid: `string`]: [`MediaStreamTrack`](MediaStreamTrack.md)

___

### trackBySSRC

• `Readonly` **trackBySSRC**: `Object` = `{}`

#### Index signature

▪ [ssrc: `string`]: [`MediaStreamTrack`](MediaStreamTrack.md)

___

### tracks

• `Readonly` **tracks**: [`MediaStreamTrack`](MediaStreamTrack.md)[] = `[]`

___

### type

• `Readonly` **type**: ``"receiver"``

___

### uuid

• `Readonly` **uuid**: `string`

## Accessors

### nackEnabled

• `get` **nackEnabled**(): `undefined` \| [`RTCPFB`](../modules.md#rtcpfb)

#### Returns

`undefined` \| [`RTCPFB`](../modules.md#rtcpfb)

___

### pliEnabled

• `get` **pliEnabled**(): `undefined` \| [`RTCPFB`](../modules.md#rtcpfb)

#### Returns

`undefined` \| [`RTCPFB`](../modules.md#rtcpfb)

___

### track

• `get` **track**(): [`MediaStreamTrack`](MediaStreamTrack.md)

#### Returns

[`MediaStreamTrack`](MediaStreamTrack.md)

___

### twccEnabled

• `get` **twccEnabled**(): `undefined` \| [`RTCPFB`](../modules.md#rtcpfb)

#### Returns

`undefined` \| [`RTCPFB`](../modules.md#rtcpfb)

## Methods

### addTrack

▸ **addTrack**(`track`): `boolean`

#### Parameters

| Name | Type |
| :------ | :------ |
| `track` | [`MediaStreamTrack`](MediaStreamTrack.md) |

#### Returns

`boolean`

___

### getStats

▸ **getStats**(): `void`

todo impl

#### Returns

`void`

___

### handleRtcpPacket

▸ **handleRtcpPacket**(`packet`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `packet` | [`RtcpPacket`](../modules.md#rtcppacket) |

#### Returns

`void`

___

### handleRtpByRid

▸ **handleRtpByRid**(`packet`, `rid`, `extensions`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `packet` | [`RtpPacket`](RtpPacket.md) |
| `rid` | `string` |
| `extensions` | `Extensions` |

#### Returns

`void`

___

### handleRtpBySsrc

▸ **handleRtpBySsrc**(`packet`, `extensions`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `packet` | [`RtpPacket`](RtpPacket.md) |
| `extensions` | `Extensions` |

#### Returns

`void`

___

### prepareReceive

▸ **prepareReceive**(`params`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `params` | [`RTCRtpReceiveParameters`](../interfaces/RTCRtpReceiveParameters.md) |

#### Returns

`void`

___

### runRtcp

▸ **runRtcp**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

___

### sendRtcpPLI

▸ **sendRtcpPLI**(`mediaSsrc`): `Promise`\<`void`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `mediaSsrc` | `number` |

#### Returns

`Promise`\<`void`\>

___

### setDtlsTransport

▸ **setDtlsTransport**(`dtls`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `dtls` | [`RTCDtlsTransport`](RTCDtlsTransport.md) |

#### Returns

`void`

___

### setupTWCC

▸ **setupTWCC**(`mediaSourceSsrc`): `void`

setup TWCC if supported

#### Parameters

| Name | Type |
| :------ | :------ |
| `mediaSourceSsrc` | `number` |

#### Returns

`void`

___

### stop

▸ **stop**(): `void`

#### Returns

`void`

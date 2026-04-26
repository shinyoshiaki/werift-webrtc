[**werift**](../README.md) • **Docs**

***

[werift](../globals.md) / RTCRtpReceiver

# Class: RTCRtpReceiver

## Constructors

### new RTCRtpReceiver()

> **new RTCRtpReceiver**(`config`, `kind`, `rtcpSsrc`): [`RTCRtpReceiver`](RTCRtpReceiver.md)

#### Parameters

• **config**: [`PeerConfig`](../interfaces/PeerConfig.md)

• **kind**: [`Kind`](../type-aliases/Kind.md)

• **rtcpSsrc**: `number`

#### Returns

[`RTCRtpReceiver`](RTCRtpReceiver.md)

## Properties

### config

> `readonly` **config**: [`PeerConfig`](../interfaces/PeerConfig.md)

***

### dtlsTransport

> **dtlsTransport**: [`RTCDtlsTransport`](RTCDtlsTransport.md)

***

### kind

> **kind**: [`Kind`](../type-aliases/Kind.md)

***

### lastSRtimestamp

> `readonly` **lastSRtimestamp**: `object` = `{}`

last sender Report Timestamp
compactNtp

#### Index Signature

 \[`ssrc`: `number`\]: `number`

***

### latestRepairedRid?

> `optional` **latestRepairedRid**: `string`

***

### latestRid?

> `optional` **latestRid**: `string`

***

### onPacketLost

> `readonly` **onPacketLost**: [`Event`](Event.md)\<[[`GenericNack`](GenericNack.md)]\>

***

### onRtcp

> `readonly` **onRtcp**: [`Event`](Event.md)\<[[`RtcpPacket`](../type-aliases/RtcpPacket.md)]\>

***

### receiveLastSRTimestamp

> `readonly` **receiveLastSRTimestamp**: `object` = `{}`

seconds

#### Index Signature

 \[`ssrc`: `number`\]: `number`

***

### receiverTWCC?

> `optional` **receiverTWCC**: `ReceiverTWCC`

***

### remoteStreamId?

> `optional` **remoteStreamId**: `string`

***

### remoteTrackId?

> `optional` **remoteTrackId**: `string`

***

### rtcpRunning

> **rtcpRunning**: `boolean` = `false`

***

### rtcpSsrc

> **rtcpSsrc**: `number`

***

### sdesMid?

> `optional` **sdesMid**: `string`

***

### stopped

> **stopped**: `boolean` = `false`

***

### trackByRID

> `readonly` **trackByRID**: `object` = `{}`

#### Index Signature

 \[`rid`: `string`\]: [`MediaStreamTrack`](MediaStreamTrack.md)

***

### trackBySSRC

> `readonly` **trackBySSRC**: `object` = `{}`

#### Index Signature

 \[`ssrc`: `string`\]: [`MediaStreamTrack`](MediaStreamTrack.md)

***

### tracks

> `readonly` **tracks**: [`MediaStreamTrack`](MediaStreamTrack.md)[] = `[]`

***

### type

> `readonly` **type**: `"receiver"` = `"receiver"`

***

### uuid

> `readonly` **uuid**: `string`

## Accessors

### nackEnabled

> `get` **nackEnabled**(): `undefined` \| [`RTCPFB`](../type-aliases/RTCPFB.md)

#### Returns

`undefined` \| [`RTCPFB`](../type-aliases/RTCPFB.md)

***

### pliEnabled

> `get` **pliEnabled**(): `undefined` \| [`RTCPFB`](../type-aliases/RTCPFB.md)

#### Returns

`undefined` \| [`RTCPFB`](../type-aliases/RTCPFB.md)

***

### track

> `get` **track**(): [`MediaStreamTrack`](MediaStreamTrack.md)

#### Returns

[`MediaStreamTrack`](MediaStreamTrack.md)

***

### twccEnabled

> `get` **twccEnabled**(): `undefined` \| [`RTCPFB`](../type-aliases/RTCPFB.md)

#### Returns

`undefined` \| [`RTCPFB`](../type-aliases/RTCPFB.md)

## Methods

### addTrack()

> **addTrack**(`track`): `boolean`

#### Parameters

• **track**: [`MediaStreamTrack`](MediaStreamTrack.md)

#### Returns

`boolean`

***

### getStats()

> **getStats**(): `void`

todo impl

#### Returns

`void`

***

### handleRtcpPacket()

> **handleRtcpPacket**(`packet`): `void`

#### Parameters

• **packet**: [`RtcpPacket`](../type-aliases/RtcpPacket.md)

#### Returns

`void`

***

### handleRtpByRid()

> **handleRtpByRid**(`packet`, `rid`, `extensions`): `void`

#### Parameters

• **packet**: [`RtpPacket`](RtpPacket.md)

• **rid**: `string`

• **extensions**: [`Extensions`](../interfaces/Extensions.md)

#### Returns

`void`

***

### handleRtpBySsrc()

> **handleRtpBySsrc**(`packet`, `extensions`): `void`

#### Parameters

• **packet**: [`RtpPacket`](RtpPacket.md)

• **extensions**: [`Extensions`](../interfaces/Extensions.md)

#### Returns

`void`

***

### prepareReceive()

> **prepareReceive**(`params`): `void`

#### Parameters

• **params**: [`RTCRtpReceiveParameters`](../interfaces/RTCRtpReceiveParameters.md)

#### Returns

`void`

***

### runRtcp()

> **runRtcp**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

***

### sendRtcpPLI()

> **sendRtcpPLI**(`mediaSsrc`): `Promise`\<`void`\>

#### Parameters

• **mediaSsrc**: `number`

#### Returns

`Promise`\<`void`\>

***

### setDtlsTransport()

> **setDtlsTransport**(`dtls`): `void`

#### Parameters

• **dtls**: [`RTCDtlsTransport`](RTCDtlsTransport.md)

#### Returns

`void`

***

### setupTWCC()

> **setupTWCC**(`mediaSourceSsrc`): `void`

setup TWCC if supported

#### Parameters

• **mediaSourceSsrc**: `number`

#### Returns

`void`

***

### stop()

> **stop**(): `void`

#### Returns

`void`

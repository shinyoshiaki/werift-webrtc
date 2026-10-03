[**werift**](../README.md)

***

[werift](../globals.md) / RTCRtpReceiver

# Class: RTCRtpReceiver

## Constructors

### new RTCRtpReceiver()

> **new RTCRtpReceiver**(`config`, `kind`, `rtcpSsrc`): [`RTCRtpReceiver`](RTCRtpReceiver.md)

#### Parameters

##### config

[`PeerConfig`](../interfaces/PeerConfig.md)

##### kind

[`Kind`](../type-aliases/Kind.md)

##### rtcpSsrc

`number`

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

### learnedTrackSsrcs

> `readonly` **learnedTrackSsrcs**: `Set`\<`number`\>

SSRCs of `trackBySSRC` learned from RID packets rather than SDP.

***

### onPacketLost

> `readonly` **onPacketLost**: [`Event`](Event.md)\<\[[`GenericNack`](GenericNack.md)\]\>

***

### onRtcp

> `readonly` **onRtcp**: [`Event`](Event.md)\<\[[`RtcpPacket`](../type-aliases/RtcpPacket.md)\]\>

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

### remoteStreamIds

> **remoteStreamIds**: `string`[] = `[]`

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

#### Get Signature

> **get** **nackEnabled**(): `undefined` \| [`RTCPFB`](../type-aliases/RTCPFB.md)

##### Returns

`undefined` \| [`RTCPFB`](../type-aliases/RTCPFB.md)

***

### pliEnabled

#### Get Signature

> **get** **pliEnabled**(): `undefined` \| [`RTCPFB`](../type-aliases/RTCPFB.md)

##### Returns

`undefined` \| [`RTCPFB`](../type-aliases/RTCPFB.md)

***

### track

#### Get Signature

> **get** **track**(): [`MediaStreamTrack`](MediaStreamTrack.md)

##### Returns

[`MediaStreamTrack`](MediaStreamTrack.md)

***

### transport

#### Get Signature

> **get** **transport**(): [`RTCDtlsTransport`](RTCDtlsTransport.md)

##### Returns

[`RTCDtlsTransport`](RTCDtlsTransport.md)

***

### twccEnabled

#### Get Signature

> **get** **twccEnabled**(): `undefined` \| [`RTCPFB`](../type-aliases/RTCPFB.md)

##### Returns

`undefined` \| [`RTCPFB`](../type-aliases/RTCPFB.md)

## Methods

### addTrack()

> **addTrack**(`track`): `boolean`

#### Parameters

##### track

[`MediaStreamTrack`](MediaStreamTrack.md)

#### Returns

`boolean`

***

### collectStats()

> **collectStats**(`timestamp`): [`RTCStats`](../interfaces/RTCStats.md)[]

#### Parameters

##### timestamp

`number`

#### Returns

[`RTCStats`](../interfaces/RTCStats.md)[]

***

### commitStagedReceive()

> **commitStagedReceive**(): `void`

Internal: the transaction committed, staged payload types and RTX pairs apply.

#### Returns

`void`

***

### discardStagedReceive()

> **discardStagedReceive**(): `void`

Internal: drop values staged by an earlier remote pranswer. A later
pranswer or the final answer replaces that proposal as a whole.

#### Returns

`void`

***

### endTracks()

> **endTracks**(): `void`

transceiver の停止確定時に remote track を ended にする

#### Returns

`void`

***

### getStats()

> **getStats**(): `Promise`\<[`RTCStatsReport`](RTCStatsReport.md)\>

#### Returns

`Promise`\<[`RTCStatsReport`](RTCStatsReport.md)\>

***

### getStatsRootIds()

> **getStatsRootIds**(`selector`?): `string`[]

#### Parameters

##### selector?

[`MediaStreamTrack`](MediaStreamTrack.md)

#### Returns

`string`[]

***

### handleRtcpPacket()

> **handleRtcpPacket**(`packet`): `void`

#### Parameters

##### packet

[`RtcpPacket`](../type-aliases/RtcpPacket.md)

#### Returns

`void`

***

### handleRtpByRid()

> **handleRtpByRid**(`packet`, `rid`, `extensions`): `void`

#### Parameters

##### packet

[`RtpPacket`](RtpPacket.md)

##### rid

`string`

##### extensions

[`Extensions`](../interfaces/Extensions.md)

#### Returns

`void`

***

### handleRtpBySsrc()

> **handleRtpBySsrc**(`packet`, `extensions`): `void`

#### Parameters

##### packet

[`RtpPacket`](RtpPacket.md)

##### extensions

[`Extensions`](../interfaces/Extensions.md)

#### Returns

`void`

***

### pliNegotiation()

> **pliNegotiation**(`mediaSsrc`): `object`

Internal: whether PLI is negotiated for `mediaSsrc`, and the payload type
that decides it. PLI follows the negotiated receive codec of this SSRC:
the live codec table (current while a proposal is pending, switched at
commit and restored on rollback), not the codec its track was created with.

#### Parameters

##### mediaSsrc

`number`

#### Returns

`object`

##### allowed

> **allowed**: `boolean`

##### payloadType

> **payloadType**: `undefined` \| `number`

***

### prepareReceive()

> **prepareReceive**(`params`, `__namedParameters`): `void`

Receive tables are keyed by payload type and RTX SSRC. With
`deferConflicts` (a pending offer or pranswer), a new key applies at once
so provisional RTP decodes, but a key the current session already uses
with another value is staged: current RTP keeps its codec and RTX pairing
until the transaction commits, and rollback drops the staged value.

#### Parameters

##### params

[`RTCRtpReceiveParameters`](../interfaces/RTCRtpReceiveParameters.md)

##### \_\_namedParameters

###### deferConflicts?

`boolean` = `false`

#### Returns

`void`

***

### restoreReceiveTables()

> **restoreReceiveTables**(`snapshot`): `void`

Internal: replace the decode tables with a rollback baseline.

#### Parameters

##### snapshot

###### codecs

\{\} = `...`

###### ssrcByRtx

\{\} = `...`

###### stagedCodecs

\{\} = `...`

###### stagedSsrcByRtx

\{\} = `...`

#### Returns

`void`

***

### resyncCodecs()

> **resyncCodecs**(`params`, `mediaSourceSsrc`?): `void`

Replace receiver codec state after a negotiated codec preference change.
Use only when the transaction commits; pending descriptions stage through
prepareReceive() so the current decode path remains available.

#### Parameters

##### params

[`RTCRtpReceiveParameters`](../interfaces/RTCRtpReceiveParameters.md)

##### mediaSourceSsrc?

`number`

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

##### mediaSsrc

`number`

#### Returns

`Promise`\<`void`\>

***

### setDtlsTransport()

> **setDtlsTransport**(`dtls`): `void`

#### Parameters

##### dtls

[`RTCDtlsTransport`](RTCDtlsTransport.md)

#### Returns

`void`

***

### setupTWCC()

> **setupTWCC**(`mediaSourceSsrc`): `void`

setup TWCC if supported

#### Parameters

##### mediaSourceSsrc

`number`

#### Returns

`void`

***

### snapshotReceiveTables()

> **snapshotReceiveTables**(): `object`

Internal: capture the decode tables for a negotiation rollback baseline.

#### Returns

`object`

##### codecs

> **codecs**: `object`

###### Index Signature

\[`key`: `number`\]: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)

##### ssrcByRtx

> **ssrcByRtx**: `object`

###### Index Signature

\[`key`: `number`\]: `number`

##### stagedCodecs

> **stagedCodecs**: `object`

###### Index Signature

\[`key`: `number`\]: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)

##### stagedSsrcByRtx

> **stagedSsrcByRtx**: `object`

###### Index Signature

\[`key`: `number`\]: `number`

***

### stop()

> **stop**(): `void`

#### Returns

`void`

[**werift**](../README.md)

***

[werift](../globals.md) / RTCRtpReceiver

# Class: RTCRtpReceiver

## Constructors

### Constructor

> **new RTCRtpReceiver**(`config`, `kind`, `rtcpSsrc`): `RTCRtpReceiver`

#### Parameters

##### config

[`PeerConfig`](../interfaces/PeerConfig.md)

##### kind

[`Kind`](../type-aliases/Kind.md)

##### rtcpSsrc

`number`

#### Returns

`RTCRtpReceiver`

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

> `optional` **latestRepairedRid?**: `string`

***

### latestRid?

> `optional` **latestRid?**: `string`

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

> `optional` **receiverTWCC?**: `ReceiverTWCC`

***

### remoteStreamId?

> `optional` **remoteStreamId?**: `string`

***

### remoteStreamIds

> **remoteStreamIds**: `string`[] = `[]`

***

### remoteTrackId?

> `optional` **remoteTrackId?**: `string`

***

### rtcpRunning

> **rtcpRunning**: `boolean` = `false`

***

### rtcpSsrc

> **rtcpSsrc**: `number`

***

### sdesMid?

> `optional` **sdesMid?**: `string`

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

> **get** **nackEnabled**(): [`RTCPFB`](../type-aliases/RTCPFB.md) \| `undefined`

##### Returns

[`RTCPFB`](../type-aliases/RTCPFB.md) \| `undefined`

***

### nackStats

#### Get Signature

> **get** **nackStats**(): [`NackStats`](../type-aliases/NackStats.md)

##### Returns

[`NackStats`](../type-aliases/NackStats.md)

***

### pliEnabled

#### Get Signature

> **get** **pliEnabled**(): [`RTCPFB`](../type-aliases/RTCPFB.md) \| `undefined`

`a=rtcp-fb:<pt> nack pli` (RFC 4585): a generic `nack` alone does not allow PLI.

##### Returns

[`RTCPFB`](../type-aliases/RTCPFB.md) \| `undefined`

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

> **get** **twccEnabled**(): [`RTCPFB`](../type-aliases/RTCPFB.md) \| `undefined`

##### Returns

[`RTCPFB`](../type-aliases/RTCPFB.md) \| `undefined`

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

> **getStatsRootIds**(`selector?`): `string`[]

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

### keepUnboundTracks()

> **keepUnboundTracks**(`tracks`): `void`

Internal: tracks a replaced remote offer gave this receiver stay its
tracks; the SSRCs the replacing offer gives take them over.

#### Parameters

##### tracks

[`MediaStreamTrack`](MediaStreamTrack.md)[]

#### Returns

`void`

***

### markLastSentSequence()

> **markLastSentSequence**(`sequenceNumber`): `void`

nonstandard: tell the NACK handler the sender's last sequence number, so
losses at the tail of a stream are NACKed too.

#### Parameters

##### sequenceNumber

`number`

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

> **payloadType**: `number` \| `undefined`

***

### prepareReceive()

> **prepareReceive**(`params`, `__namedParameters?`): `void`

Receive tables are keyed by payload type and RTX SSRC. With
`deferConflicts` (a pending offer or pranswer), a new key applies at once
so provisional RTP decodes, but a key the current session already uses
with another value is staged: current RTP keeps its codec and RTX pairing
until the transaction commits, and rollback drops the staged value.

#### Parameters

##### params

[`RTCRtpReceiveParameters`](../interfaces/RTCRtpReceiveParameters.md)

##### \_\_namedParameters?

###### deferConflicts?

`boolean` = `false`

#### Returns

`void`

***

### releaseProvisionalSsrc()

> **releaseProvisionalSsrc**(`ssrc`): `void`

Internal: a superseded pending description no longer routes `ssrc`.

#### Parameters

##### ssrc

`number`

#### Returns

`void`

***

### restoreNegotiationState()

> **restoreNegotiationState**(`state`): `void`

Internal: return to a negotiation baseline taken by `snapshotNegotiationState`.

#### Parameters

##### state

###### receiverTWCC

`ReceiverTWCC` \| `undefined` = `...`

###### receiveTables

\{ `codecs`: \{\[`pt`: `number`\]: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md); \}; `ssrcByRtx`: \{\[`rtxSsrc`: `number`\]: `number`; \}; `stagedCodecs`: \{\[`pt`: `number`\]: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md); \}; `stagedSsrcByRtx`: \{\[`rtxSsrc`: `number`\]: `number`; \}; \} = `...`

###### receiveTables.codecs

\{\[`pt`: `number`\]: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md); \} = `...`

###### receiveTables.ssrcByRtx

\{\[`rtxSsrc`: `number`\]: `number`; \} = `...`

###### receiveTables.stagedCodecs

\{\[`pt`: `number`\]: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md); \} = `...`

###### receiveTables.stagedSsrcByRtx

\{\[`rtxSsrc`: `number`\]: `number`; \} = `...`

###### remoteStreamId

`string` \| `undefined` = `...`

###### remoteStreamIds

`string`[] = `...`

###### remoteTrackId

`string` \| `undefined` = `...`

###### trackByRID

\{\[`rid`: `string`\]: [`MediaStreamTrack`](MediaStreamTrack.md); \} = `...`

###### trackBySSRC

\{\[`ssrc`: `string`\]: [`MediaStreamTrack`](MediaStreamTrack.md); \} = `...`

###### tracks

[`MediaStreamTrack`](MediaStreamTrack.md)[] = `...`

###### unboundTracks

[`MediaStreamTrack`](MediaStreamTrack.md)[] = `...`

#### Returns

`void`

***

### restoreReceiveTables()

> **restoreReceiveTables**(`snapshot`): `void`

Internal: replace the decode tables with a rollback baseline.

#### Parameters

##### snapshot

###### codecs

\{\[`pt`: `number`\]: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md); \} = `...`

###### ssrcByRtx

\{\[`rtxSsrc`: `number`\]: `number`; \} = `...`

###### stagedCodecs

\{\[`pt`: `number`\]: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md); \} = `...`

###### stagedSsrcByRtx

\{\[`rtxSsrc`: `number`\]: `number`; \} = `...`

#### Returns

`void`

***

### resyncCodecs()

> **resyncCodecs**(`params`, `mediaSourceSsrc?`): `void`

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

### setNackOptions()

> **setNackOptions**(`options`): `void`

nonstandard: change the NACK retry policy (latency budget) at runtime.
Applies to packets already waiting for a retransmission too.

#### Parameters

##### options

[`NackOptions`](../type-aliases/NackOptions.md)

#### Returns

`void`

***

### setupTWCC()

> **setupTWCC**(`mediaSourceSsrc`, `negotiated?`): `void`

setup TWCC if supported

#### Parameters

##### mediaSourceSsrc

`number`

##### negotiated?

`boolean` = `...`

#### Returns

`void`

***

### snapshotNegotiationState()

> **snapshotNegotiationState**(): `object`

Internal: everything a negotiation may change on this receiver, for a
rollback baseline. Packet-driven runtime (statistics, NACK, RTCP) is not
part of it.

#### Returns

`object`

##### receiverTWCC

> **receiverTWCC**: `ReceiverTWCC` \| `undefined`

##### receiveTables

> **receiveTables**: `object`

###### receiveTables.codecs

> **codecs**: `object`

###### Index Signature

\[`pt`: `number`\]: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)

###### receiveTables.ssrcByRtx

> **ssrcByRtx**: `object`

###### Index Signature

\[`rtxSsrc`: `number`\]: `number`

###### receiveTables.stagedCodecs

> **stagedCodecs**: `object`

###### Index Signature

\[`pt`: `number`\]: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)

###### receiveTables.stagedSsrcByRtx

> **stagedSsrcByRtx**: `object`

###### Index Signature

\[`rtxSsrc`: `number`\]: `number`

##### remoteStreamId

> **remoteStreamId**: `string` \| `undefined`

##### remoteStreamIds

> **remoteStreamIds**: `string`[]

##### remoteTrackId

> **remoteTrackId**: `string` \| `undefined`

##### trackByRID

> **trackByRID**: `object`

###### Index Signature

\[`rid`: `string`\]: [`MediaStreamTrack`](MediaStreamTrack.md)

##### trackBySSRC

> **trackBySSRC**: `object`

###### Index Signature

\[`ssrc`: `string`\]: [`MediaStreamTrack`](MediaStreamTrack.md)

##### tracks

> **tracks**: [`MediaStreamTrack`](MediaStreamTrack.md)[]

##### unboundTracks

> **unboundTracks**: [`MediaStreamTrack`](MediaStreamTrack.md)[]

***

### snapshotReceiveTables()

> **snapshotReceiveTables**(): `object`

Internal: capture the decode tables for a negotiation rollback baseline.

#### Returns

`object`

##### codecs

> **codecs**: `object`

###### Index Signature

\[`pt`: `number`\]: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)

##### ssrcByRtx

> **ssrcByRtx**: `object`

###### Index Signature

\[`rtxSsrc`: `number`\]: `number`

##### stagedCodecs

> **stagedCodecs**: `object`

###### Index Signature

\[`pt`: `number`\]: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)

##### stagedSsrcByRtx

> **stagedSsrcByRtx**: `object`

###### Index Signature

\[`rtxSsrc`: `number`\]: `number`

***

### stop()

> **stop**(): `void`

#### Returns

`void`

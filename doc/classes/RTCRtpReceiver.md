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

### mediaSsrcByRid

> `readonly` **mediaSsrcByRid**: `object` = `{}`

Simulcast RTX without `a=ssrc-group:FID` (RFC 8852). A RID has one media
SSRC at a time ([mediaSsrcByRid](#mediassrcbyrid), learned from `rtp-stream-id`); a
media SSRC change without renegotiation is a reset of the RID's stream
(see `switchRidMedia`). An RTX SSRC is bound to the RID it repairs
([ridByRtxSsrc](#ridbyrtxssrc), learned from `repaired-rtp-stream-id`) and its
packet is restored to the RID's current media SSRC only when it fills a
hole NACK detected there (`NackHandler.canRepair`).
Packet-driven live state like [learnedTrackSsrcs](#learnedtrackssrcs): a negotiation
(commit, rollback, `resyncCodecs`) keeps it, a later packet updates it.

#### Index Signature

\[`rid`: `string`\]: `number`

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

### repairedMediaByRtx

> `readonly` **repairedMediaByRtx**: `object` = `{}`

Media SSRC each RTX SSRC last repaired (decides retirement and eviction).

#### Index Signature

\[`rtxSsrc`: `number`\]: `number`

***

### retiredSsrcsByRid

> `readonly` **retiredSsrcsByRid**: `object` = `{}`

SSRCs retired by a media SSRC change, per RID, oldest first.

#### Index Signature

\[`rid`: `string`\]: `number`[]

***

### ridByRtxSsrc

> `readonly` **ridByRtxSsrc**: `object` = `{}`

#### Index Signature

\[`rtxSsrc`: `number`\]: `string`

***

### rtcpRunning

> **rtcpRunning**: `boolean` = `false`

***

### rtcpSsrc

> **rtcpSsrc**: `number`

***

### rtxSsrcsByRid

> `readonly` **rtxSsrcsByRid**: `object` = `{}`

RTX SSRCs of [ridByRtxSsrc](#ridbyrtxssrc) per RID, oldest bound first.

#### Index Signature

\[`rid`: `string`\]: `number`[]

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

\[`rid`: `string`\]: [`MediaStreamTrack`](MediaStreamTrack.md)\<[`Kind`](../type-aliases/Kind.md)\>

***

### trackBySSRC

> `readonly` **trackBySSRC**: `object` = `{}`

#### Index Signature

\[`ssrc`: `string`\]: [`MediaStreamTrack`](MediaStreamTrack.md)\<[`Kind`](../type-aliases/Kind.md)\>

***

### tracks

> `readonly` **tracks**: [`MediaStreamTrack`](MediaStreamTrack.md)\<[`Kind`](../type-aliases/Kind.md)\>[] = `[]`

***

### type

> `readonly` **type**: `"receiver"` = `"receiver"`

***

### uuid

> `readonly` **uuid**: `string`

## Accessors

### acceptsUnknownSsrc

#### Get Signature

> **get** **acceptsUnknownSsrc**(): `boolean`

Internal (router): whether an RTP stream whose SSRC no description names
may be learned for this receiver: the remote description gave it neither
an SSRC nor a RID (no track besides the default one), and it is running.

##### Returns

`boolean`

***

### fallbackSsrc

#### Get Signature

> **get** **fallbackSsrc**(): `number` \| `undefined`

Internal (router): the newest SSRC learned from a packet for a remote
m-line without `a=ssrc` and without RIDs (RFC 9143 section 9.2); see
fallbackStreams.

##### Returns

`number` \| `undefined`

***

### fallbackSsrcs

#### Get Signature

> **get** **fallbackSsrcs**(): `number`[]

Internal (router): every learned fallback SSRC, oldest first.

##### Returns

`number`[]

***

### nackEnabled

#### Get Signature

> **get** **nackEnabled**(): [`RTCPFB`](../type-aliases/RTCPFB.md) \| `undefined`

##### Returns

[`RTCPFB`](../type-aliases/RTCPFB.md) \| `undefined`

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

> **get** **track**(): [`MediaStreamTrack`](MediaStreamTrack.md)\<[`Kind`](../type-aliases/Kind.md)\>

##### Returns

[`MediaStreamTrack`](MediaStreamTrack.md)\<[`Kind`](../type-aliases/Kind.md)\>

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

### acceptFallbackPacket()

> **acceptFallbackPacket**(`ssrc`, `ext`, `ownMid`): `void`

Internal (router): a packet of the fallback SSRC `ssrc` at `ext` this
receiver takes (a negotiated media payload type): it advances the
highest sequence number and, with `ownMid`, the last MID update.

#### Parameters

##### ssrc

`number`

##### ext

`number`

##### ownMid

`boolean`

#### Returns

`void`

***

### addTrack()

> **addTrack**(`track`): `boolean`

#### Parameters

##### track

[`MediaStreamTrack`](MediaStreamTrack.md)

#### Returns

`boolean`

***

### adoptDefaultTrack()

> **adoptDefaultTrack**(`ssrc`, `codec?`): [`MediaStreamTrack`](MediaStreamTrack.md)\<[`Kind`](../type-aliases/Kind.md)\>

Internal (router): the track a description's first SSRC binds when this
m-line had neither an SSRC nor a RID and `ontrack` already announced the
default track: the application keeps receiving on the object it got,
and `ontrack` does not fire again for it.

#### Parameters

##### ssrc

`number`

##### codec?

[`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)

#### Returns

[`MediaStreamTrack`](MediaStreamTrack.md)\<[`Kind`](../type-aliases/Kind.md)\>

***

### adoptFallbackSsrcForRid()

> **adoptFallbackSsrcForRid**(`rid`, `ssrc`): `boolean`

Internal: at the commit that gives `rid`, the SSRC that already carried
it is that RID's media SSRC (learned, so later packets without
`rtp-stream-id` keep reaching the RID's track). False without the track.

#### Parameters

##### rid

`string`

##### ssrc

`number`

#### Returns

`boolean`

***

### bindFallbackSsrc()

> **bindFallbackSsrc**(`ssrc`, `payloadType`, `from`): `void`

Internal (router): learn `ssrc` for the default track (see
fallbackStreams). Earlier SSRCs stay mapped to the same track (a
late packet of a replaced stream is delivered, nothing is reset); the
oldest beyond the bound is forgotten and handed to the router through
[takeForgottenSsrcs](#takeforgottenssrcs). `from` carries the stream state when a MID
moves the SSRC here from another m-line.

#### Parameters

##### ssrc

`number`

##### payloadType

`number`

##### from

`FallbackStream` \| \{ `mid`: `boolean`; `sequenceNumber`: `number`; \}

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

### fallbackSsrcsByRid()

> **fallbackSsrcsByRid**(): `Map`\<`string`, `number`\>

Internal: RID → newest fallback SSRC that carried it.

#### Returns

`Map`\<`string`, `number`\>

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

[`MediaStreamTrack`](MediaStreamTrack.md)\<[`Kind`](../type-aliases/Kind.md)\>

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

### handleRtxByRid()

> **handleRtxByRid**(`packet`, `repairedRid`, `extensions`): `void`

An RTX packet that names the RID it repairs (`repaired-rtp-stream-id`).
The RTX SSRC is bound to that RID; the packet is restored only when it
fills a hole of the RID's current media SSRC (see mediaSsrcOfRtx).

#### Parameters

##### packet

[`RtpPacket`](RtpPacket.md)

##### repairedRid

`string`

##### extensions

[`Extensions`](../interfaces/Extensions.md)

#### Returns

`void`

***

### hasFallbackSsrc()

> **hasFallbackSsrc**(`ssrc`): `boolean`

Internal (router): `ssrc` is one of [fallbackSsrcs](#fallbackssrcs).

#### Parameters

##### ssrc

`number`

#### Returns

`boolean`

***

### keepUnboundTracks()

> **keepUnboundTracks**(`tracks`): `void`

Internal: tracks a replaced remote offer gave this receiver stay its
tracks; the SSRCs the replacing offer gives take them over.

#### Parameters

##### tracks

[`MediaStreamTrack`](MediaStreamTrack.md)\<[`Kind`](../type-aliases/Kind.md)\>[]

#### Returns

`void`

***

### knowsSsrc()

> **knowsSsrc**(`ssrc`): `boolean`

Internal (router): a route to this receiver for `ssrc` is still in use:
a track has it (media SSRC from a description or packets), or a RID's
RTX learned it (`ridByRtxSsrc`, no track entry of its own).

#### Parameters

##### ssrc

`number`

#### Returns

`boolean`

***

### noteFallbackRid()

> **noteFallbackRid**(`ssrc`, `rid`): `void`

Internal (router): the fallback SSRC `ssrc` arrived with a RID this
m-line has no track for (a pending description's RID). The commit that
gives the RID hands the SSRC over ([adoptFallbackSsrcForRid](#adoptfallbackssrcforrid)).

#### Parameters

##### ssrc

`number`

##### rid

`string`

#### Returns

`void`

***

### observeFallbackPacket()

> **observeFallbackPacket**(`ssrc`, `sequenceNumber`): \{ `ext`: `number`; `midMayUpdate`: `boolean`; `stream`: \{ `codec?`: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md); `highestExt`: `number`; `midUpdateExt?`: `number`; `payloadType`: `number`; `rid?`: `string`; \}; \} \| `undefined`

Internal (router): where a packet of the learned fallback SSRC `ssrc`
stands, without changing anything: its extended sequence number and
whether its MID may update the mapping (RFC 9143 section 9.2: only a
packet newer than the last update does). The router applies it with
[acceptFallbackPacket](#acceptfallbackpacket) only once the packet is valid for the
receiver that takes it, so an invalid packet moves nothing.

#### Parameters

##### ssrc

`number`

##### sequenceNumber

`number`

#### Returns

\{ `ext`: `number`; `midMayUpdate`: `boolean`; `stream`: \{ `codec?`: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md); `highestExt`: `number`; `midUpdateExt?`: `number`; `payloadType`: `number`; `rid?`: `string`; \}; \} \| `undefined`

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

### readsRepairedRid()

> **readsRepairedRid**(`ssrc`, `repairedRid`): `boolean`

Internal (router): a packet of `ssrc` routed here is handled by its
repaired RID `repairedRid`
(tests/media/firefoxSimulcastRepairedRidRoute.test.ts "simulcast (RID) RTX routed by SSRC with a repaired RID (readsRepairedRid)").

#### Parameters

##### ssrc

`number`

##### repairedRid

`string`

#### Returns

`boolean`

***

### receivesMediaPayloadType()

> **receivesMediaPayloadType**(`payloadType`): `boolean`

Internal (router): the payload type is a negotiated media codec of this
receiver. RTX is not: without `ssrc-group:FID` nothing pairs an RTX SSRC
with the media SSRC.

#### Parameters

##### payloadType

`number`

#### Returns

`boolean`

***

### receivesRtxPayloadType()

> **receivesRtxPayloadType**(`payloadType`): `boolean`

Internal (router): the payload type is a negotiated RTX codec of this receiver.

#### Parameters

##### payloadType

`number`

#### Returns

`boolean`

***

### releaseFallbackSsrc()

> **releaseFallbackSsrc**(`ssrc`): `FallbackStream` \| `undefined`

Internal (router): forget one learned fallback SSRC (evicted, or moved
to the m-line a newer MID names): its track entry, NACK holes and
per-SSRC receive state go, and [takeForgottenSsrcs](#takeforgottenssrcs) hands it to the
router to drop its learned route. Returns its stream state.

#### Parameters

##### ssrc

`number`

#### Returns

`FallbackStream` \| `undefined`

***

### releaseFallbackSsrcs()

> **releaseFallbackSsrcs**(): `number`[]

Internal: forget every learned fallback SSRC, when a description gives
this m-line an SSRC or a RID or the transceiver goes. Returns them.

#### Returns

`number`[]

***

### releaseLearnedSsrc()

> **releaseLearnedSsrc**(`ssrc`): `void`

Internal (router): forget whatever packets taught this receiver about
`ssrc` — a fallback SSRC, a RID's media SSRC or a RID's RTX SSRC — when
a local sender or another m-line's description in the same RTP session
takes it. [takeForgottenSsrcs](#takeforgottenssrcs) hands it to the router to drop the
learned route. A description's own SSRC stays.

#### Parameters

##### ssrc

`number`

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

###### deferredRemote

`DeferredRemoteRtp` \| `undefined` = `...`

###### learnedTrackSsrcs

`number`[] = `...`

SSRCs of `trackBySSRC` that packets taught (not description state).

###### receiverTWCC

`ReceiverTWCC` \| `undefined` = `...`

###### receiveTables

\{ `codecs`: \{\[`pt`: `number`\]: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md); \}; `ridFidMediaByRtx`: \{\[`rtxSsrc`: `number`\]: `number`; \}; `ssrcByRtx`: \{\[`rtxSsrc`: `number`\]: `number`; \}; `stagedCodecs`: \{\[`pt`: `number`\]: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md); \}; `stagedRidFidTable`: \{\[`rtxSsrc`: `number`\]: `number`; \} \| `undefined`; `stagedSsrcByRtx`: \{\[`rtxSsrc`: `number`\]: `number`; \}; \} = `...`

###### receiveTables.codecs

\{\[`pt`: `number`\]: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md); \} = `...`

###### receiveTables.ridFidMediaByRtx

\{\[`rtxSsrc`: `number`\]: `number`; \} = `...`

###### receiveTables.ssrcByRtx

\{\[`rtxSsrc`: `number`\]: `number`; \} = `...`

###### receiveTables.stagedCodecs

\{\[`pt`: `number`\]: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md); \} = `...`

###### receiveTables.stagedRidFidTable

\{\[`rtxSsrc`: `number`\]: `number`; \} \| `undefined` = `...`

###### receiveTables.stagedSsrcByRtx

\{\[`rtxSsrc`: `number`\]: `number`; \} = `...`

###### remoteStreamId

`string` \| `undefined` = `...`

###### remoteStreamIds

`string`[] = `...`

###### remoteTrackId

`string` \| `undefined` = `...`

###### trackByRID

\{\[`rid`: `string`\]: [`MediaStreamTrack`](MediaStreamTrack.md)\<[`Kind`](../type-aliases/Kind.md)\>; \} = `...`

###### trackBySSRC

\{\[`ssrc`: `string`\]: [`MediaStreamTrack`](MediaStreamTrack.md)\<[`Kind`](../type-aliases/Kind.md)\>; \} = `...`

###### tracks

[`MediaStreamTrack`](MediaStreamTrack.md)\<[`Kind`](../type-aliases/Kind.md)\>[] = `...`

###### unboundTracks

[`MediaStreamTrack`](MediaStreamTrack.md)\<[`Kind`](../type-aliases/Kind.md)\>[] = `...`

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

###### ridFidMediaByRtx

\{\[`rtxSsrc`: `number`\]: `number`; \} = `...`

###### ssrcByRtx

\{\[`rtxSsrc`: `number`\]: `number`; \} = `...`

###### stagedCodecs

\{\[`pt`: `number`\]: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md); \} = `...`

###### stagedRidFidTable

\{\[`rtxSsrc`: `number`\]: `number`; \} \| `undefined` = `...`

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

### setupTWCC()

> **setupTWCC**(`mediaSourceSsrc`, `negotiated?`): `void`

Attach this receiver to the DTLS-transport-scoped TWCC generator.
BUNDLE audio/video share one ReceiverTWCC so interleaved
transport-wide sequences are not reported as loss.

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

##### deferredRemote

> **deferredRemote**: `DeferredRemoteRtp` \| `undefined`

##### learnedTrackSsrcs

> **learnedTrackSsrcs**: `number`[]

SSRCs of `trackBySSRC` that packets taught (not description state).

##### receiverTWCC

> **receiverTWCC**: `ReceiverTWCC` \| `undefined`

##### receiveTables

> **receiveTables**: `object`

###### receiveTables.codecs

> **codecs**: `object`

###### Index Signature

\[`pt`: `number`\]: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)

###### receiveTables.ridFidMediaByRtx

> **ridFidMediaByRtx**: `object`

###### Index Signature

\[`rtxSsrc`: `number`\]: `number`

###### receiveTables.ssrcByRtx

> **ssrcByRtx**: `object`

###### Index Signature

\[`rtxSsrc`: `number`\]: `number`

###### receiveTables.stagedCodecs

> **stagedCodecs**: `object`

###### Index Signature

\[`pt`: `number`\]: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)

###### receiveTables.stagedRidFidTable

> **stagedRidFidTable**: \{\[`rtxSsrc`: `number`\]: `number`; \} \| `undefined`

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

\[`rid`: `string`\]: [`MediaStreamTrack`](MediaStreamTrack.md)\<[`Kind`](../type-aliases/Kind.md)\>

##### trackBySSRC

> **trackBySSRC**: `object`

###### Index Signature

\[`ssrc`: `string`\]: [`MediaStreamTrack`](MediaStreamTrack.md)\<[`Kind`](../type-aliases/Kind.md)\>

##### tracks

> **tracks**: [`MediaStreamTrack`](MediaStreamTrack.md)\<[`Kind`](../type-aliases/Kind.md)\>[]

##### unboundTracks

> **unboundTracks**: [`MediaStreamTrack`](MediaStreamTrack.md)\<[`Kind`](../type-aliases/Kind.md)\>[]

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

##### ridFidMediaByRtx

> **ridFidMediaByRtx**: `object`

###### Index Signature

\[`rtxSsrc`: `number`\]: `number`

##### ssrcByRtx

> **ssrcByRtx**: `object`

###### Index Signature

\[`rtxSsrc`: `number`\]: `number`

##### stagedCodecs

> **stagedCodecs**: `object`

###### Index Signature

\[`pt`: `number`\]: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)

##### stagedRidFidTable

> **stagedRidFidTable**: \{\[`rtxSsrc`: `number`\]: `number`; \} \| `undefined`

##### stagedSsrcByRtx

> **stagedSsrcByRtx**: `object`

###### Index Signature

\[`rtxSsrc`: `number`\]: `number`

***

### stop()

> **stop**(): `void`

#### Returns

`void`

***

### takeDroppedFidRtxSsrcs()

> **takeDroppedFidRtxSsrcs**(): `number`[]

Internal (router): FID RTX SSRCs a commit removed that the description
no longer describes otherwise; their description routes go
(tests/media/firefoxSimulcastRepairedRidRoute.test.ts "確定で FID の組が外れた RTX SSRC を BUNDLE の別 m-line が MID と repaired RID 付きで使うと、その m-line の RID のトラックへ復元される";
tests/media/firefoxSimulcastRepairedRidRoute.test.ts "RID の m-line が FID の組を外して SSRC で送る記述に変わっても、a=ssrc の RTX として記述された RTX SSRC は経路を失わず復元される").

#### Returns

`number`[]

***

### takeForgottenSsrcs()

> **takeForgottenSsrcs**(): `number`[]

Internal (router): SSRCs whose packet-driven route is no longer wanted:
retired by a media SSRC change of their RID or evicted by a bound. The
router drops their learned routes after each packet.

#### Returns

`number`[]

***

### takeRejectedSsrcs()

> **takeRejectedSsrcs**(): `number`[]

Internal (router): SSRCs of packets this receiver rejected as invalid
(an unnegotiated payload type, a non-RTX packet naming a repaired RID, a
RID without a track, a malformed RED payload). Such a packet must not
teach a route, but it says nothing against a route learned before it:
the router undoes only a route the rejected packet itself just added.

#### Returns

`number`[]

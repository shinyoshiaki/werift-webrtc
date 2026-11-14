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

Internal (router): the SSRC learned from a packet for a remote m-line
without `a=ssrc` and without RIDs (RFC 9143 section 9.2). It is bound to
the default track, the one `ontrack` already announced, so the
application keeps receiving on that object. At most one per receiver:
see [bindFallbackSsrc](#bindfallbackssrc). Derived from `trackBySSRC`, so a
negotiation snapshot and rollback keep it consistent with the tables.

##### Returns

`number` \| `undefined`

***

### hasStagedTracks

#### Get Signature

> **get** **hasStagedTracks**(): `boolean`

Internal (router): whether a pending description gives this m-line, whose
current session is without SSRC and RID, tracks; see stagedTracks.

##### Returns

`boolean`

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

### stagedDefaultSsrc

#### Get Signature

> **get** **stagedDefaultSsrc**(): `number` \| `undefined`

Internal (router): the SSRC a staged adoption gives the announced track.

##### Returns

`number` \| `undefined`

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

### adoptDefaultTrack()

> **adoptDefaultTrack**(`ssrc`, `codec?`): [`MediaStreamTrack`](MediaStreamTrack.md)

#### Parameters

##### ssrc

`number`

##### codec?

[`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)

#### Returns

[`MediaStreamTrack`](MediaStreamTrack.md)

***

### bindFallbackSsrc()

> **bindFallbackSsrc**(`ssrc`, `payloadType`): `number` \| `undefined`

Internal (router): bind `ssrc` to the default track as the fallback SSRC
(see [fallbackSsrc](#fallbackssrc)). A previous fallback SSRC is replaced (a SIP
re-INVITE or a media server switch changes the SSRC of the single
stream): its track entry, NACK holes and per-SSRC receive state are
dropped, and [takeForgottenSsrcs](#takeforgottenssrcs) hands it to the router to drop
its learned route. Returns the replaced SSRC.

#### Parameters

##### ssrc

`number`

##### payloadType

`number`

#### Returns

`number` \| `undefined`

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

### dropStagedTracks()

> **dropStagedTracks**(): `void`

Internal: forget what an earlier pending description staged; the
description being applied decides anew.

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

### handOverFallbackToRid()

> **handOverFallbackToRid**(): `void`

Internal (router, at the commit): the fallback SSRC already arrived with
a RID the committed description gave (`mediaSsrcByRid`), so it is that
RID's media SSRC now: its track entry moves to the RID's track and stays
learned, so the route survives the release of the fallback and later
packets without `rtp-stream-id` keep reaching the RID's track.

#### Returns

`void`

***

### isRetiredFallbackSsrc()

> **isRetiredFallbackSsrc**(`ssrc`): `boolean`

Internal (router): whether `ssrc` was the fallback SSRC this receiver
replaced. A late (reordered) packet of the old stream must not switch the
receiver back and reset the state of the current one, so the router does
not learn it again. Bounded by MAX\_RETIRED\_FALLBACK\_SSRCS.

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

[`MediaStreamTrack`](MediaStreamTrack.md)[]

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

> **releaseFallbackSsrc**(): `number` \| `undefined`

Internal (router): drop the fallback SSRC, when the SSRC changes or a
description gives this m-line an SSRC or a RID. The router drops its
route through [takeForgottenSsrcs](#takeforgottenssrcs).

#### Returns

`number` \| `undefined`

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

###### defaultTrackCodec

[`RTCRtpCodecParameters`](RTCRtpCodecParameters.md) \| `undefined` = `...`

`adoptDefaultTrack` gives the announced track a description's codec.

###### learnedTrackSsrcs

`number`[] = `...`

SSRCs of `trackBySSRC` that packets taught (not description state).

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

###### stagedTracks

\{ `codec?`: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md); `ssrc?`: `number`; `tracks`: [`MediaStreamTrack`](MediaStreamTrack.md)[]; \} \| `undefined` = `...`

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

### retireFallbackSsrc()

> **retireFallbackSsrc**(): `number` \| `undefined`

Internal (router): hand the fallback SSRC over to the m-line a packet's
MID names (RFC 9143 section 9.2: the MID updates the SSRC mapping). It is
released like a replaced one, and remembered as retired so a late packet
naming this m-line does not take it back. Returns the SSRC.

#### Returns

`number` \| `undefined`

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

##### defaultTrackCodec

> **defaultTrackCodec**: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md) \| `undefined`

`adoptDefaultTrack` gives the announced track a description's codec.

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

##### stagedTracks

> **stagedTracks**: \{ `codec?`: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md); `ssrc?`: `number`; `tracks`: [`MediaStreamTrack`](MediaStreamTrack.md)[]; \} \| `undefined`

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

### stageDefaultTrack()

> **stageDefaultTrack**(`ssrc`, `codec?`): `void`

Internal (router): the announced track adopts `ssrc` and `codec` at the commit.

#### Parameters

##### ssrc

`number`

##### codec?

[`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)

#### Returns

`void`

***

### stageTrack()

> **stageTrack**(`track`): `void`

Internal (router): a track of another SSRC or of a RID, added at the commit.

#### Parameters

##### track

[`MediaStreamTrack`](MediaStreamTrack.md)

#### Returns

`void`

***

### stop()

> **stop**(): `void`

#### Returns

`void`

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
RID without a track). Such a packet must not teach a route, but it says
nothing against a route learned before it: the router undoes only a
route the rejected packet itself just added.

#### Returns

`number`[]

***

### takeStagedTracks()

> **takeStagedTracks**(): \{ `codec?`: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md); `ssrc?`: `number`; `tracks`: [`MediaStreamTrack`](MediaStreamTrack.md)[]; \} \| `undefined`

Internal (router): the staged tracks, cleared; the router applies them at commit.

#### Returns

\{ `codec?`: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md); `ssrc?`: `number`; `tracks`: [`MediaStreamTrack`](MediaStreamTrack.md)[]; \} \| `undefined`

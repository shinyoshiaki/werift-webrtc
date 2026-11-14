[**werift**](../README.md)

***

[werift](../globals.md) / RtpRouter

# Class: RtpRouter

RTP routing tables shared by the current session and a pending proposal.
One rule covers every key: a pending remote offer or pranswer may **add**
keys, effective at once so provisional RTP flows, but a key the current
session uses keeps its value until the final answer. A conflicting value is
rejected before any mutation or staged until commit; rollback drops what was
staged and restores the baseline (`snapshotRoutes` / `restoreRoutes`).

| Key | Table | Conflicting proposal |
| --- | --- | --- |
| Payload type → codec | receiver codec table | remap rejected (RFC 3264 section 8.3.2); fmtp / rtcp-fb change staged |
| Header extension ID → URI | `extIdUriMap` | remap of an ID in use rejected (RFC 8285 section 7); a URI on a new ID is an addition |
| SSRC → receiver | `ssrcTable` | move to another m-line staged |
| RTX SSRC → media SSRC | receiver RTX table | changed pairing staged |
| MID+RID → receiver | `ridTable` | RIDs are scoped to their m-line (RFC 8851): no conflict |
| Sender SSRC → sender | `ssrcTable` | application state: rollback keeps every live sender's route |

Packet-driven routes are not description state: an SSRC first seen with
`rtp-stream-id` / `repaired-rtp-stream-id` is added to `ssrcTable` as
learned (`learnedSsrcs`), and the receiver learns RID → media SSRC and RTX
SSRC → RID (`mediaSsrcByRid` / `ridByRtxSsrc`). Commit and rollback keep them.
They are bounded per RID: an SSRC the receiver retires (a media SSRC change
of the RID) or evicts loses its learned route here (`takeForgottenSsrcs`),
and unregistering a transceiver drops its learned SSRCs.

| Packet-driven key | Learned when | Bound |
| --- | --- | --- |
| SSRC → receiver (RID) | `rtp-stream-id` / `repaired-rtp-stream-id` names a route | per RID (receiver) |
| SSRC → receiver (simulcast) | the SSRC is a learned track SSRC of a RID receiver on the packet's transport | as above |
| SSRC → receiver (fallback, RFC 9143 section 9.2) | see learnUnknownSsrc | one per receiver |

The fallback serves remote m-lines without `a=ssrc` and RIDs (SIP gateways,
SBCs, media servers): an SSRC no route, RID or simulcast track knows is
learned for the receiver the packet's MID names, or else for the receiver
of the only m-line on the packet's transport that receives the payload type
(one with `a=ssrc` or RIDs counts too, and then nothing is learned); when
that is ambiguous, or the packet comes without a
transport (`routeRtp(packet)`), it is dropped. The learned SSRC binds the
default track `ontrack` announced (`RTCRtpReceiver.bindFallbackSsrc`); a new
SSRC that passes the same checks replaces it, so tables stay bounded. Like
the other packet-driven routes it is added at once while a description is
pending, and commit and rollback keep it while the m-line stays without
SSRC and RID. A description that gives the m-line an SSRC or a RID drops it
when it applies as an answer or commits; while it is pending the current
session keeps receiving on the fallback SSRC and rollback keeps it. The
first SSRC such a description gives binds the announced track as well
(`RTCRtpReceiver.adoptDefaultTrack`), so `ontrack` does not fire again.
Unregistering the transceiver drops the fallback SSRC. A packet whose MID
names another m-line than the one holding its fallback SSRC updates the
mapping (RFC 9143 section 9.2): the SSRC moves there when that m-line may
learn it, else the packet is dropped; the old m-line retires the SSRC, so
its late packets do not take it back. Routes from SDP, RIDs and simulcast
keep their receiver whatever the MID (existing behaviour). A rollback keeps
the receiver packets taught last, even over a baseline route packets
taught another receiver.

An SSRC is unique per RTP session only: a route learned from packets
belongs to its receiver's current transport (a transceiver moved to another
transport takes it along, and the old transport no longer reaches it). RTP and RTCP (SR, RR and every
feedback naming an SSRC) arriving on another transport never resolve to it;
when that transport's receiver learns the same numeric SSRC (fallback or
RID) it keeps its own route, and an SSRC another transport's receiver
replaced is a new stream here. Routes from SDP and sender routes are not
scoped by transport (a packet of another transport naming them reaches
them, as before). A remote stream using a local sender's SSRC is not
learned.

A payload type or extension ID counts as in use only when both current
descriptions carry it for the m-line. RID lookup uses MID+RID when the
packet's MID names a route, else the RID alone. `extIdUriMap` is shared by
the whole PeerConnection: m-lines on separate transports that map one ID to
different URIs are not supported. A current remote SSRC that a later answer
omits stays routed; only SSRCs a replaced pranswer alone added are dropped.

## Constructors

### Constructor

> **new RtpRouter**(): `RtpRouter`

#### Returns

`RtpRouter`

## Properties

### extIdUriMap

> **extIdUriMap**: `object` = `{}`

#### Index Signature

\[`id`: `number`\]: `string`

***

### keyFrameRequestRouting

> **keyFrameRequestRouting**: [`KeyFrameRequestRouting`](../type-aliases/KeyFrameRequestRouting.md) = `"compatible"`

***

### learnedSsrcs

> `readonly` **learnedSsrcs**: `Set`\<`number`\>

SSRCs registered from received packets (simulcast after RID stops being
sent), not from SDP. Negotiation rollback keeps these entries.

***

### ridTable

> **ridTable**: `object` = `{}`

Keyed by ridRouteKey (MID + RID).

#### Index Signature

\[`midAndRid`: `string`\]: [`RTCRtpReceiver`](RTCRtpReceiver.md) \| [`RTCRtpSender`](RTCRtpSender.md)

***

### ssrcTable

> **ssrcTable**: `object` = `{}`

#### Index Signature

\[`ssrc`: `number`\]: [`RTCRtpReceiver`](RTCRtpReceiver.md) \| [`RTCRtpSender`](RTCRtpSender.md)

***

### transceivers

> **transceivers**: () => readonly [`RTCRtpTransceiver`](RTCRtpTransceiver.md)[]

Internal: the transceivers of the PeerConnection, for the fallback of
learnUnknownSsrc. Set by the TransceiverManager; the router keeps
no table of its own for it, so negotiation snapshots stay as they are.

#### Returns

readonly [`RTCRtpTransceiver`](RTCRtpTransceiver.md)[]

## Accessors

### staged

#### Get Signature

> **get** **staged**(): `StagedRoutes`

Test-only observation of staged routes.

##### Returns

`StagedRoutes`

## Methods

### commitStaged()

> **commitStaged**(): `void`

Internal: the negotiation committed, staged routes replace current ones.

#### Returns

`void`

***

### discardProvisional()

> **discardProvisional**(): `void`

Internal: drop the routes an earlier pending description added at once.

#### Returns

`void`

***

### registerRtpReceiverByRid()

> **registerRtpReceiverByRid**(`transceiver`, `param`, `params`, `__namedParameters?`): `void`

#### Parameters

##### transceiver

[`RTCRtpTransceiver`](RTCRtpTransceiver.md)

##### param

[`RTCRtpSimulcastParameters`](RTCRtpSimulcastParameters.md)

##### params

[`RTCRtpReceiveParameters`](../interfaces/RTCRtpReceiveParameters.md)

##### \_\_namedParameters?

###### deferConflicts?

`boolean` = `false`

#### Returns

`void`

***

### registerRtpReceiverBySsrc()

> **registerRtpReceiverBySsrc**(`transceiver`, `params`, `__namedParameters?`): `void`

With `deferConflicts` (a pending offer or pranswer) an SSRC the current
session routes to another receiver is staged until commit; new SSRCs route
at once so provisional RTP flows.

#### Parameters

##### transceiver

[`RTCRtpTransceiver`](RTCRtpTransceiver.md)

##### params

[`RTCRtpReceiveParameters`](../interfaces/RTCRtpReceiveParameters.md)

##### \_\_namedParameters?

###### deferConflicts?

`boolean` = `false`

#### Returns

`void`

***

### registerRtpSender()

> **registerRtpSender**(`sender`): `void`

#### Parameters

##### sender

[`RTCRtpSender`](RTCRtpSender.md)

#### Returns

`void`

***

### restoreRoutes()

> **restoreRoutes**(`snapshot`, `__namedParameters`): `void`

Internal: return to a negotiation baseline. Two kinds of route are not
description state and survive: SSRCs learned from packets for an endpoint
still attached, and the own SSRC of every live sender (including one the
application added while the description was pending). Likewise a route
packets taught before the baseline and later dropped (an SSRC retired by
a media SSRC change of its RID, or evicted) stays dropped: the baseline
does not bring packet-driven routes back.

#### Parameters

##### snapshot

###### extIdUriMap

\{\[`id`: `number`\]: `string`; \} = `...`

###### learnedSsrcs

`number`[] = `...`

Routes of `ssrcTable` that packets taught (not description state).

###### ridTable

\{\[`midAndRid`: `string`\]: [`RTCRtpReceiver`](RTCRtpReceiver.md) \| [`RTCRtpSender`](RTCRtpSender.md); \} = `...`

###### ssrcTable

\{\[`ssrc`: `number`\]: [`RTCRtpReceiver`](RTCRtpReceiver.md) \| [`RTCRtpSender`](RTCRtpSender.md); \} = `...`

###### staged

`StagedRoutes` = `...`

##### \_\_namedParameters

###### endpoints

`Set`\<[`RTCRtpReceiver`](RTCRtpReceiver.md) \| [`RTCRtpSender`](RTCRtpSender.md)\>

###### liveSenders

[`RTCRtpSender`](RTCRtpSender.md)[]

#### Returns

`void`

***

### restoreStaged()

> **restoreStaged**(`snapshot`): `void`

Internal: restore staged routes (an empty snapshot discards them).

#### Parameters

##### snapshot

`StagedRoutes`

#### Returns

`void`

***

### routeRtcp()

> **routeRtcp**(`packet`, `dtlsTransport?`): `void`

#### Parameters

##### packet

[`RtcpPacket`](../type-aliases/RtcpPacket.md)

##### dtlsTransport?

[`RTCDtlsTransport`](RTCDtlsTransport.md)

#### Returns

`void`

***

### routeRtp()

> **routeRtp**(`packet`, `dtlsTransport?`): `void`

Simulcast (RFC 8852): a packet with `rtp-stream-id` is a layer's media,
one with `repaired-rtp-stream-id` is the RTX stream repairing that layer.
The first such packet registers its SSRC as a learned route, because the
sender may stop sending these extensions (libwebrtc does once it receives
an RTCP RR); later packets of the SSRC are routed by SSRC alone.

#### Parameters

##### packet

[`RtpPacket`](RtpPacket.md)

##### dtlsTransport?

[`RTCDtlsTransport`](RTCDtlsTransport.md)

#### Returns

`void`

***

### snapshotRoutes()

> **snapshotRoutes**(): `object`

Internal: every route a negotiation may change, for a rollback baseline.

#### Returns

##### extIdUriMap

> **extIdUriMap**: `object`

###### Index Signature

\[`id`: `number`\]: `string`

##### learnedSsrcs

> **learnedSsrcs**: `number`[]

Routes of `ssrcTable` that packets taught (not description state).

##### ridTable

> **ridTable**: `object`

###### Index Signature

\[`midAndRid`: `string`\]: [`RTCRtpReceiver`](RTCRtpReceiver.md) \| [`RTCRtpSender`](RTCRtpSender.md)

##### ssrcTable

> **ssrcTable**: `object`

###### Index Signature

\[`ssrc`: `number`\]: [`RTCRtpReceiver`](RTCRtpReceiver.md) \| [`RTCRtpSender`](RTCRtpSender.md)

##### staged

> **staged**: `StagedRoutes`

***

### snapshotStaged()

> **snapshotStaged**(): `StagedRoutes`

Internal: capture staged routes for a transaction baseline or checkpoint.

#### Returns

`StagedRoutes`

***

### unregisterTransceiver()

> **unregisterTransceiver**(`transceiver`): `void`

#### Parameters

##### transceiver

[`RTCRtpTransceiver`](RTCRtpTransceiver.md)

#### Returns

`void`

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
| SSRC → receiver | `routes` (origin `sdp`) | move to another m-line staged |
| RTX SSRC → media SSRC | receiver RTX table | changed pairing staged |
| MID+RID → receiver | `ridTable` | RIDs are scoped to their m-line (RFC 8851): no conflict |
| Sender SSRC → sender | `routes` (origin `sender`) | application state: rollback keeps every live sender's route |

Packet-driven routes are not description state: an SSRC first seen with
`rtp-stream-id` / `repaired-rtp-stream-id` gets a route of origin
`learned`, and the receiver learns RID → media SSRC and RTX
SSRC → RID (`mediaSsrcByRid` / `ridByRtxSsrc`). Commit and rollback keep them.
They are bounded per RID: an SSRC the receiver retires (a media SSRC change
of the RID) or evicts loses its learned route here (`takeForgottenSsrcs`),
and unregistering a transceiver drops its learned SSRCs.

| Packet-driven key | Learned when | Bound |
| --- | --- | --- |
| SSRC → receiver (RID) | `rtp-stream-id` / `repaired-rtp-stream-id` names a route | per RID (receiver) |
| SSRC → receiver (simulcast) | the SSRC is a learned track SSRC of a RID receiver on the packet's transport | as above |
| SSRC → receiver (fallback, RFC 9143 section 9.2) | see learnUnknownSsrc | 8 per receiver, oldest forgotten first |

The fallback serves remote m-lines without `a=ssrc` and RIDs (SIP gateways,
SBCs, media servers): an SSRC no route, RID or simulcast track knows is
learned for the receiver the packet's MID names, or else for the receiver
of the only m-line on the packet's transport that receives the payload type
(one with `a=ssrc` or RIDs counts too, and then nothing is learned); when
that is ambiguous, or the packet comes without a
transport (`routeRtp(packet)`), it is dropped. A learned SSRC maps to the
default track `ontrack` announced (`RTCRtpReceiver.bindFallbackSsrc`). A
new SSRC (a SIP re-INVITE, a media server switch) is learned beside the
earlier ones, which keep mapping to the same track: a late packet of a
replaced stream is delivered there and resets nothing; `track.ssrc` is the
newest, and the oldest beyond 8 is forgotten. Like the other packet-driven
routes they are added at once while a description is pending, and commit
and rollback keep them while the m-line stays without SSRC and RID (a
rollback forgets those learned with a payload type only the rolled-back
description gave).

A pending description does not touch an m-line whose current session is
without SSRC and RID: its SSRCs and RIDs wait in
`RTCRtpReceiver.deferredRemote` and register at the commit
(`commitStaged`), as an answer's would; rollback drops them with the rest
of the description. Until then the current session's track, statistics,
routes and learning stay as they are: a packet of the pending SSRC is
learned like any unknown SSRC, and one with a pending RID is the current
stream's. At the commit the learned SSRCs go (the description's SSRCs and
RIDs route from now on), except one that already carried a committed RID,
which becomes that RID's media SSRC. The first SSRC of the description
binds the announced track (`RTCRtpReceiver.adoptDefaultTrack`), so `ontrack`
does not fire again for it; a RID track replacing it is announced after
the commit. Unregistering the transceiver drops the learned SSRCs.

A MID updates the mapping of a learned SSRC (RFC 9143 section 9.2) only
from a packet whose extended sequence number is newer than the one of the
last update: an older packet is delivered through the mapping it finds.
A newer MID naming another m-line moves the SSRC there when that m-line may
learn it, else the packet is dropped. Routes from SDP, RIDs and simulcast
keep their receiver whatever the MID (existing behaviour). A rollback keeps
the receiver packets taught last, even over a baseline route packets
taught another receiver.

Every identifier of a packet — SSRC, RID (`rtp-stream-id`), RRID
(`repaired-rtp-stream-id`) and MID — resolves within the packet's RTP
session (its DTLS transport) only: a route, RID route or m-line of another
transport is never reached, and a MID naming one drops the packet.

An SSRC is unique per RTP session only, so `routes` keeps, per SSRC, a
set of routes `{ endpoint, origin }`, each belonging to its endpoint's
current `dtlsTransport` (a transceiver moved to another transport takes
it along; a sender without a transport yet belongs to every one). A
packet, RTP or RTCP (SR, RR and every feedback naming an SSRC), resolves
to the highest ranked route of its transport (endpointBySsrc):

| Origin | Added by | Rank in one RTP session | Other transports |
| --- | --- | --- | --- |
| `sender` | `registerRtpSender` | 1: a remote stream using it is a collision (RFC 3550 section 8.2): its RTP is dropped and nothing is learned, whatever RID, repaired RID or MID it carries | other streams, routed there |
| `sdp` | `registerRtpReceiver` (an answer, a commit, or a pending description without conflict) | 2: a learned owner forgets the SSRC; another receiver's description route of the SSRC goes (the later description wins) | other streams, routed there |
| `learned` | packets (RID, simulcast, fallback) | 3: never beside a `sender` / `sdp` route of another endpoint | other streams, routed there |

A receiver that loses its learned SSRC — a fallback SSRC, a RID's media
SSRC or a RID's RTX SSRC — because a sender or description of its session
registers it, or a BUNDLE merge brings it into such a session, forgets it
(`RTCRtpReceiver.releaseLearnedSsrc`), so its track and statistics agree
with the table. A description route a pending description added in one
session is taken again in the session its receiver has at the commit.
Sender enumeration (TWCC fan-out, keyframe fallback) reads the same
routes, within the packet's session.

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

### announcedTrack

> **announcedTrack**: (`transceiver`) => [`MediaStreamTrack`](MediaStreamTrack.md) \| `undefined`

Internal: the track `ontrack` last announced for a transceiver (set by
the TransceiverManager). A replacement offer resets `firedReceiving`
before it applies, while the announcement of the default track stands.

#### Parameters

##### transceiver

[`RTCRtpTransceiver`](RTCRtpTransceiver.md)

#### Returns

[`MediaStreamTrack`](MediaStreamTrack.md) \| `undefined`

***

### extIdUriMap

> **extIdUriMap**: `object` = `{}`

#### Index Signature

\[`id`: `number`\]: `string`

***

### keyFrameRequestRouting

> **keyFrameRequestRouting**: `"standard"` \| `"fallback"` = `"fallback"`

***

### ridTable

> **ridTable**: `object` = `{}`

Keyed by ridRouteKey (MID + RID).

#### Index Signature

\[`midAndRid`: `string`\]: [`RTCRtpReceiver`](RTCRtpReceiver.md) \| [`RTCRtpSender`](RTCRtpSender.md)

***

### transceivers

> **transceivers**: () => readonly [`RTCRtpTransceiver`](RTCRtpTransceiver.md)[]

Internal: the transceivers of the PeerConnection, for the fallback of
learnUnknownSsrc. Set by the TransceiverManager; the router keeps
no table of its own for it, so negotiation snapshots stay as they are.

#### Returns

readonly [`RTCRtpTransceiver`](RTCRtpTransceiver.md)[]

## Accessors

### learnedSsrcs

#### Get Signature

> **get** **learnedSsrcs**(): `ReadonlySet`\<`number`\>

Test / observation view: SSRCs that have a route packets taught.

##### Returns

`ReadonlySet`\<`number`\>

***

### routeEntries

#### Get Signature

> **get** **routeEntries**(): `object`[]

Test / observation view: every route with its SSRC.

##### Returns

`object`[]

***

### ssrcTable

#### Get Signature

> **get** **ssrcTable**(): `object`

Test / observation view: SSRC → the endpoint a packet without a
transport reaches (the highest ranked route, the first of a rank).

##### Returns

`object`

***

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

A local sender's own SSRC. In its RTP session it outranks a receiver
route: a learned SSRC there is a remote collision (RFC 3550 section 8.2)
and is forgotten; an SDP route there stays but receives nothing. Routes
of other transports are other streams and stay.

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

###### ridTable

\{\[`midAndRid`: `string`\]: [`RTCRtpReceiver`](RTCRtpReceiver.md) \| [`RTCRtpSender`](RTCRtpSender.md); \} = `...`

###### routes

(readonly \[`number`, `object`[]\])[] = `...`

Every route (description, sender and packet-driven ones).

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

Deliver an RTCP packet within the RTP session of `dtlsTransport` (`routing/rtcpRouting.ts`).

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

##### ridTable

> **ridTable**: `object`

###### Index Signature

\[`midAndRid`: `string`\]: [`RTCRtpReceiver`](RTCRtpReceiver.md) \| [`RTCRtpSender`](RTCRtpSender.md)

##### routes

> **routes**: (readonly \[`number`, `object`[]\])[]

Every route (description, sender and packet-driven ones).

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

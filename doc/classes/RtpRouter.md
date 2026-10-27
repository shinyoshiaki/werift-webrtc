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
application added while the description was pending).

#### Parameters

##### snapshot

###### extIdUriMap

\{\[`id`: `number`\]: `string`; \} = `...`

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

> **routeRtp**(`packet`): `void`

#### Parameters

##### packet

[`RtpPacket`](RtpPacket.md)

#### Returns

`void`

***

### snapshotRoutes()

> **snapshotRoutes**(): `object`

Internal: every route a negotiation may change, for a rollback baseline.

#### Returns

`object`

##### extIdUriMap

> **extIdUriMap**: `object`

###### Index Signature

\[`id`: `number`\]: `string`

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

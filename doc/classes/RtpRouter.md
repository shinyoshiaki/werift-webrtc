[**werift**](../README.md)

***

[werift](../globals.md) / RtpRouter

# Class: RtpRouter

## Constructors

### new RtpRouter()

> **new RtpRouter**(): [`RtpRouter`](RtpRouter.md)

#### Returns

[`RtpRouter`](RtpRouter.md)

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

Keyed by [ridRouteKey](../functions/ridRouteKey.md) (MID + RID).

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

### registerRtpReceiverByRid()

> **registerRtpReceiverByRid**(`transceiver`, `param`, `params`, `__namedParameters`): `void`

#### Parameters

##### transceiver

[`RTCRtpTransceiver`](RTCRtpTransceiver.md)

##### param

[`RTCRtpSimulcastParameters`](RTCRtpSimulcastParameters.md)

##### params

[`RTCRtpReceiveParameters`](../interfaces/RTCRtpReceiveParameters.md)

##### \_\_namedParameters

###### deferConflicts?

`boolean` = `false`

#### Returns

`void`

***

### registerRtpReceiverBySsrc()

> **registerRtpReceiverBySsrc**(`transceiver`, `params`, `__namedParameters`): `void`

With `deferConflicts` (a pending offer or pranswer) an SSRC the current
session routes to another receiver is staged until commit; new SSRCs route
at once so provisional RTP flows.

#### Parameters

##### transceiver

[`RTCRtpTransceiver`](RTCRtpTransceiver.md)

##### params

[`RTCRtpReceiveParameters`](../interfaces/RTCRtpReceiveParameters.md)

##### \_\_namedParameters

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

> **routeRtcp**(`packet`): `void`

#### Parameters

##### packet

[`RtcpPacket`](../type-aliases/RtcpPacket.md)

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

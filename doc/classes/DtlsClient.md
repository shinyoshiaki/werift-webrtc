[**werift**](../README.md)

***

[werift](../globals.md) / DtlsClient

# Class: DtlsClient

## Extends

- [`DtlsSocket`](DtlsSocket.md)

## Constructors

### new DtlsClient()

> **new DtlsClient**(`options`): [`DtlsClient`](DtlsClient.md)

Public constructor — accepts stable [Options](../interfaces/Options.md) only.

#### Parameters

##### options

[`Options`](../interfaces/Options.md)

#### Returns

[`DtlsClient`](DtlsClient.md)

#### Overrides

[`DtlsSocket`](DtlsSocket.md).[`constructor`](DtlsSocket.md#constructors)

## Properties

### associationAbort

> `protected` **associationAbort**: `AbortController`

Cancels pending [waitForReady](DtlsSocket.md#waitforready) association sleeps on terminal teardown.
Replaced only if a future multi-HS redesign needs a fresh controller mid-life.

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`associationAbort`](DtlsSocket.md#associationabort)

***

### associationTornDown

> `protected` **associationTornDown**: `boolean` = `false`

True after association hard/graceful/fatal teardown so Public APIs stay
disabled for pure 1.2, pure 1.3, and dual paths alike (even if transport
close is still racing or engine13 has already been cleared).
Dual client also flips dualPhase=closed; this flag is the base guard.

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`associationTornDown`](DtlsSocket.md#associationtorndown)

***

### cipher

> **cipher**: [`CipherContext`](CipherContext.md)

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`cipher`](DtlsSocket.md#cipher)

***

### connected

> **connected**: `boolean` = `false`

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`connected`](DtlsSocket.md#connected)

***

### dtls

> **dtls**: `DtlsContext`

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`dtls`](DtlsSocket.md#dtls)

***

### engine13?

> `protected` `optional` **engine13**: `Dtls13Connection`

When set, DTLS 1.3 engine owns the transport and crypto state.

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`engine13`](DtlsSocket.md#engine13)

***

### extensions

> **extensions**: `Extension`[] = `[]`

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`extensions`](DtlsSocket.md#extensions)

***

### onClose

> `readonly` **onClose**: [`Event`](Event.md)\<`any`[]\>

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`onClose`](DtlsSocket.md#onclose)

***

### onConnect

> `readonly` **onConnect**: [`Event`](Event.md)\<`any`[]\>

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`onConnect`](DtlsSocket.md#onconnect)

***

### onData

> `readonly` **onData**: [`Event`](Event.md)\<\[`Buffer`\<`ArrayBufferLike`\>\]\>

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`onData`](DtlsSocket.md#ondata)

***

### onError

> `readonly` **onError**: [`Event`](Event.md)\<\[`Error`\]\>

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`onError`](DtlsSocket.md#onerror)

***

### onHandleHandshakes()

> **onHandleHandshakes**: (`assembled`) => `Promise`\<`void`\>

#### Parameters

##### assembled

`FragmentedHandshake`[]

#### Returns

`Promise`\<`void`\>

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`onHandleHandshakes`](DtlsSocket.md#onhandlehandshakes)

***

### options

> **options**: [`Options`](../interfaces/Options.md)

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`options`](DtlsSocket.md#options-1)

***

### protocolVersions

> `readonly` **protocolVersions**: [`DtlsVersion`](../enumerations/DtlsVersion.md)[]

Negotiated / configured protocol versions (priority order).

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`protocolVersions`](DtlsSocket.md#protocolversions)

***

### sessionType

> **sessionType**: `SessionTypes`

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`sessionType`](DtlsSocket.md#sessiontype-1)

***

### srtp

> **srtp**: [`SrtpContext`](SrtpContext.md)

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`srtp`](DtlsSocket.md#srtp)

***

### transport

> `readonly` **transport**: `TransportContext`

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`transport`](DtlsSocket.md#transport)

## Accessors

### isDtls13

#### Get Signature

> **get** **isDtls13**(): `boolean`

True when this socket is operating on the DTLS 1.3 engine.

##### Returns

`boolean`

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`isDtls13`](DtlsSocket.md#isdtls13)

***

### remoteCertificate

#### Get Signature

> **get** **remoteCertificate**(): `undefined` \| `Buffer`\<`ArrayBufferLike`\>

##### Returns

`undefined` \| `Buffer`\<`ArrayBufferLike`\>

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`remoteCertificate`](DtlsSocket.md#remotecertificate)

## Methods

### abortAssociationWaits()

> `protected` **abortAssociationWaits**(): `void`

Aborts association-owned async waits ([waitForReady](DtlsSocket.md#waitforready) sleeps).
Invoked on every terminal transition so pending timers/promises cancel
immediately (not only "wake later and check torn-down").

#### Returns

`void`

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`abortAssociationWaits`](DtlsSocket.md#abortassociationwaits)

***

### abortLegacy12Flight()

> `protected` **abortLegacy12Flight**(`error`?): `void`

Abort legacy DTLS 1.2 flight: optional fatalError, flight=99, cancel timers.
Use on close / fatal alert / version commit away from 1.2 — not on
successful handshake complete (that only needs cancelLegacy12FlightTimers).

#### Parameters

##### error?

`Error`

#### Returns

`void`

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`abortLegacy12Flight`](DtlsSocket.md#abortlegacy12flight)

***

### assertReadyForApplicationApi()

> `protected` **assertReadyForApplicationApi**(`op`): `void`

Reject Public data / re-connect APIs while dual is probing or after hard close.
Active committed12 / committed13 / pure 1.2 (none) are allowed.

#### Parameters

##### op

`string`

#### Returns

`void`

#### Overrides

[`DtlsSocket`](DtlsSocket.md).[`assertReadyForApplicationApi`](DtlsSocket.md#assertreadyforapplicationapi)

***

### bridgeEngine13()

> `protected` **bridgeEngine13**(`engine`, `options`?): `void`

Wire DTLS 1.3 engine events onto this socket.

#### Parameters

##### engine

`Dtls13Connection`

##### options?

###### filterError?

(`e`) => `boolean`

#### Returns

`void`

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`bridgeEngine13`](DtlsSocket.md#bridgeengine13)

***

### cancelLegacy12FlightTimers()

> `protected` **cancelLegacy12FlightTimers**(): `void`

Cancel pending DTLS 1.2 flight retransmit sleeps only (leave flight number).
Use on successful handshake complete so Flight4/Flight5 sleep does not
linger until the next RTO after onConnect.

#### Returns

`void`

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`cancelLegacy12FlightTimers`](DtlsSocket.md#cancellegacy12flighttimers)

***

### clearSendPeerPin()

> `protected` **clearSendPeerPin**(): `void`

Clear TX pin on association terminal teardown.

#### Returns

`void`

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`clearSendPeerPin`](DtlsSocket.md#clearsendpeerpin)

***

### close()

> **close**(): `void`

Public close: tear down all dual candidates, association carrier, and
1.2 flight timers. Phase becomes permanently `closed`.
Fires public onClose once (bridge is disposed before eng.close).

#### Returns

`void`

#### Overrides

[`DtlsSocket`](DtlsSocket.md).[`close`](DtlsSocket.md#close)

***

### closeLegacy12Association()

> `protected` **closeLegacy12Association**(`firePublicOnClose`): `void`

Local close for pure DTLS 1.2 (server and non-overridden paths).
Terminal transition + optional single public onClose (client dual uses
closeAssociationHard instead).

#### Parameters

##### firePublicOnClose

`boolean` = `true`

#### Returns

`void`

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`closeLegacy12Association`](DtlsSocket.md#closelegacy12association)

***

### connect()

> **connect**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

***

### exportKeyingMaterial()

> **exportKeyingMaterial**(`label`, `length`): `Buffer`\<`ArrayBufferLike`\>

#### Parameters

##### label

`string`

##### length

`number`

#### Returns

`Buffer`\<`ArrayBufferLike`\>

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`exportKeyingMaterial`](DtlsSocket.md#exportkeyingmaterial)

***

### extractSessionKeys()

> **extractSessionKeys**(`keyLength`, `saltLength`): `object`

#### Parameters

##### keyLength

`number`

##### saltLength

`number`

#### Returns

`object`

##### localKey

> **localKey**: `any` = `clientKey`

##### localSalt

> **localSalt**: `any` = `clientSalt`

##### remoteKey

> **remoteKey**: `any` = `serverKey`

##### remoteSalt

> **remoteSalt**: `any` = `serverSalt`

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`extractSessionKeys`](DtlsSocket.md#extractsessionkeys)

***

### failAssociationFromEngine13()

> `protected` **failAssociationFromEngine13**(`err`): `boolean`

Dual association fatal teardown: phase → closed, all candidates + 1.2 flight
stopped, RX drops further inject. Invoked from bridge on non-soft 1.3 errors
(committed13 fatal alert, 1.3-only version mismatch, RTO exhaust, …).
HVR soft (DtlsVersionSelected) never reaches here (filterError).
Public onClose is fired by bridge after this returns (not here).

#### Parameters

##### err

`Error`

#### Returns

`boolean`

#### Overrides

[`DtlsSocket`](DtlsSocket.md).[`failAssociationFromEngine13`](DtlsSocket.md#failassociationfromengine13)

***

### failLegacy12Association()

> `protected` **failLegacy12Association**(`error`): `boolean`

DTLS 1.2 fatal alert / protocol_version on dual association (incl. committed12).
Same ownership as 1.3 fatal: phase closed, carrier/transport down, Public API off.
Caller fires onError then onClose when this returns true.

#### Parameters

##### error

`Error`

#### Returns

`boolean`

#### Overrides

[`DtlsSocket`](DtlsSocket.md).[`failLegacy12Association`](DtlsSocket.md#faillegacy12association)

***

### finishLegacy12PeerCloseWithOptionalNotify()

> `protected` **finishLegacy12PeerCloseWithOptionalNotify**(`after`?): `void`

Best-effort 1.2 close_notify reply then onClose/transport free even if
transport.send never settles (~250ms budget, parity with 1.3).

#### Parameters

##### after?

() => `void`

#### Returns

`void`

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`finishLegacy12PeerCloseWithOptionalNotify`](DtlsSocket.md#finishlegacy12peerclosewithoptionalnotify)

***

### handleFragmentHandshake()

> **handleFragmentHandshake**(`messages`): `FragmentedHandshake`[]

#### Parameters

##### messages

`FragmentedHandshake`[]

#### Returns

`FragmentedHandshake`[]

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`handleFragmentHandshake`](DtlsSocket.md#handlefragmenthandshake)

***

### handleUdpDatagram()

> `protected` **handleUdpDatagram**(`data`, `addr`?): `void`

Process one UDP datagram on the DTLS 1.2 record path.
Subclasses (dual client) may intercept before calling this.

RX ownership (when pin set): drop non-pin peers before parse/decrypt so
spoofed UDP / carrier inject cannot deliver app data or force terminal
via unauthenticated alerts.

#### Parameters

##### data

`Buffer`

##### addr?

readonly \[`string`, `number`\]

#### Returns

`void`

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`handleUdpDatagram`](DtlsSocket.md#handleudpdatagram)

***

### hasAssociationPeerAuth()

> `protected` **hasAssociationPeerAuth**(): `boolean`

Cookie / connect pin is the association peer-auth boundary for DTLS 1.2.
Pre-pin (server pre-cookie): unauthenticated sources must not force
association-fatal teardown (alert / malformed HS DoS).

#### Returns

`boolean`

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`hasAssociationPeerAuth`](DtlsSocket.md#hasassociationpeerauth)

***

### isAuthenticatedLegacy12Record()

> `protected` **isAuthenticatedLegacy12Record**(`epoch`): `boolean`

After keys exist (connected or write epoch advanced), only epoch>0 records
are cryptographically authenticated for lifecycle alerts. Epoch-0 fatal /
close_notify must not tear down a post-handshake association (unauth DoS).

#### Parameters

##### epoch

`number`

#### Returns

`boolean`

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`isAuthenticatedLegacy12Record`](DtlsSocket.md#isauthenticatedlegacy12record)

***

### keyUpdate()

> **keyUpdate**(`requestUpdate`): `Promise`\<`void`\>

Request KeyUpdate on DTLS 1.3 connections.

#### Parameters

##### requestUpdate

`boolean` = `false`

#### Returns

`Promise`\<`void`\>

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`keyUpdate`](DtlsSocket.md#keyupdate)

***

### matchesPinnedPeer()

> `protected` **matchesPinnedPeer**(`addr`?): `boolean`

True when inbound source matches association TX/RX pin, or no pin yet
(pre-cookie server / pre-connect). After pin, unknown or non-pin peer
must not drive handshake / app / alert lifecycle (RX ownership).

#### Parameters

##### addr?

readonly \[`string`, `number`\]

#### Returns

`boolean`

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`matchesPinnedPeer`](DtlsSocket.md#matchespinnedpeer)

***

### onEngine13PeerOrLocalClose()

> `protected` **onEngine13PeerOrLocalClose**(): `void`

Peer close_notify / engine onClose: full association closed (phase, carrier,
transport, public API guards). Called after public onClose so handlers can
still inspect engine13, then hard-closes association ownership.
Does not re-fire onClose (already delivered by bridge; dualPhase already closed).

#### Returns

`void`

#### Overrides

[`DtlsSocket`](DtlsSocket.md).[`onEngine13PeerOrLocalClose`](DtlsSocket.md#onengine13peerorlocalclose)

***

### onLegacy12PeerCloseNotify()

> `protected` **onLegacy12PeerCloseNotify**(): `void`

Peer close_notify on DTLS 1.2 path (committed12 / pure dual 1.2):
sync Public-API terminal (associationTornDown), best-effort reply with
send budget, then hard-close which flips dualPhase=closed + onClose once.
Do not set dualPhase=closed before hard-close or firePublicOnClose is skipped.

#### Returns

`void`

#### Overrides

[`DtlsSocket`](DtlsSocket.md).[`onLegacy12PeerCloseNotify`](DtlsSocket.md#onlegacy12peerclosenotify)

***

### pinSendPeer()

> `protected` **pinSendPeer**(`addr`?, `mode`?): `void`

Normalize and store association TX peer pin on TransportContext.

Why association-owned: UdpTransport.rinfo is overwritten by every inbound
datagram (including spoof). Flight retransmit and application send must not
follow last-rinfo alone (ticket peer-pinning / TX ownership).

#### Parameters

##### addr?

readonly \[`string`, `number`\]

##### mode?

`set-if-empty` keeps the first authenticated pin (server Flight4 /
  connect). `replace` is for dual association re-pin / client connect.

`"replace"` | `"set-if-empty"`

#### Returns

`void`

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`pinSendPeer`](DtlsSocket.md#pinsendpeer)

***

### pinSendPeerFromTransportRinfo()

> `protected` **pinSendPeerFromTransportRinfo**(`mode`): `void`

Pin from last transport rinfo when present.
Default mode is `set-if-empty` (keeps an existing authenticated pin).
Pass `replace` when the association deliberately re-pins (e.g. client connect).

#### Parameters

##### mode

`"replace"` | `"set-if-empty"`

#### Returns

`void`

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`pinSendPeerFromTransportRinfo`](DtlsSocket.md#pinsendpeerfromtransportrinfo)

***

### prepareAssociationClosedFromEngine()

> `protected` **prepareAssociationClosedFromEngine**(): `void`

Peer/engine onClose: mark dualPhase closed before public onClose so
re-entrant local close() inside handlers is idempotent (no second onClose).

#### Returns

`void`

#### Overrides

[`DtlsSocket`](DtlsSocket.md).[`prepareAssociationClosedFromEngine`](DtlsSocket.md#prepareassociationclosedfromengine)

***

### renegotiation()

> **renegotiation**(): `void`

#### Returns

`void`

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`renegotiation`](DtlsSocket.md#renegotiation)

***

### reportLegacy12Fatal()

> `protected` **reportLegacy12Fatal**(`error`): `void`

Tear down the 1.2 association then fire onError + onClose once.
Used for fatal alerts, handshake failures, probing DOWNGRD / classify error,
and ProtocolVersionError paths. Idempotent: concurrent terminal paths must
not double-fire public events.

#### Parameters

##### error

`Error`

#### Returns

`void`

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`reportLegacy12Fatal`](DtlsSocket.md#reportlegacy12fatal)

***

### resolveInboundPeer()

> `protected` **resolveInboundPeer**(`addr`?): `undefined` \| readonly \[`string`, `number`\]

Resolve inbound peer for RX ownership: explicit UDP/inject addr first,
else last transport rinfo (may be spoofed — always gate with pin).

#### Parameters

##### addr?

readonly \[`string`, `number`\]

#### Returns

`undefined` \| readonly \[`string`, `number`\]

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`resolveInboundPeer`](DtlsSocket.md#resolveinboundpeer)

***

### restorePinnedRinfo()

> `protected` **restorePinnedRinfo**(): `void`

Restore transport.rinfo to pin so spoof sources do not stick for later TX fallbacks.

#### Returns

`void`

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`restorePinnedRinfo`](DtlsSocket.md#restorepinnedrinfo)

***

### send()

> **send**(`buf`, `addr`?): `Promise`\<`void`\>

send application data

#### Parameters

##### buf

`Buffer`

##### addr?

readonly \[`string`, `number`\]

#### Returns

`Promise`\<`void`\>

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`send`](DtlsSocket.md#send)

***

### sendLegacy12CloseNotify()

> `protected` **sendLegacy12CloseNotify**(): `Promise`\<`void`\>

Best-effort close_notify on the current 1.2 write epoch.

#### Returns

`Promise`\<`void`\>

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`sendLegacy12CloseNotify`](DtlsSocket.md#sendlegacy12closenotify)

***

### sendPlaintextAlert()

> `protected` **sendPlaintextAlert**(`description`): `Promise`\<`void`\>

Send a fatal DTLSPlaintext alert (used for protocol_version mismatch).

#### Parameters

##### description

`number`

#### Returns

`Promise`\<`void`\>

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`sendPlaintextAlert`](DtlsSocket.md#sendplaintextalert)

***

### setupExtensions()

> `protected` **setupExtensions**(): `void`

#### Returns

`void`

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`setupExtensions`](DtlsSocket.md#setupextensions)

***

### udpOnMessage()

> `protected` **udpOnMessage**(`data`, `addr`?): `void`

Association inbound dispatcher (UDP onData and carrier.inject).

- closed: drop everything (no reconnect, no timer restart)
- non-association peer: drop before version commit (anti-spoof)
- active engine13 (committed13 / pure 1.3 after dual resume): forward to 1.3
- probing + 1.3 SH/HRR from association peer: version commit to 1.3
- probing + epoch-0 illegal_parameter only: suppress (legacy_cookie vs 1.3)
- else: DTLS 1.2 record path (committed12 / dual cookie / pure 1.2)

#### Parameters

##### data

`Buffer`

##### addr?

readonly \[`string`, `number`\]

#### Returns

`void`

#### Overrides

[`DtlsSocket`](DtlsSocket.md).[`udpOnMessage`](DtlsSocket.md#udponmessage)

***

### unbridgeEngine13()

> `protected` **unbridgeEngine13**(): `void`

Drop bridge subscriptions for a disposed or replaced 1.3 candidate.

#### Returns

`void`

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`unbridgeEngine13`](DtlsSocket.md#unbridgeengine13)

***

### waitForReady()

> `protected` **waitForReady**(`condition`): `Promise`\<`void`\>

#### Parameters

##### condition

() => `boolean`

#### Returns

`Promise`\<`void`\>

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`waitForReady`](DtlsSocket.md#waitforready)

[**werift**](../README.md)

***

[werift](../globals.md) / DtlsSocket

# Class: DtlsSocket

## Extended by

- [`DtlsClient`](DtlsClient.md)
- [`DtlsServer`](DtlsServer.md)

## Constructors

### new DtlsSocket()

> **new DtlsSocket**(`options`, `sessionType`): [`DtlsSocket`](DtlsSocket.md)

#### Parameters

##### options

[`Options`](../interfaces/Options.md)

##### sessionType

`SessionTypes`

#### Returns

[`DtlsSocket`](DtlsSocket.md)

## Properties

### associationAbort

> `protected` **associationAbort**: `AbortController`

Cancels pending [waitForReady](DtlsSocket.md#waitforready) association sleeps on terminal teardown.
Replaced only if a future multi-HS redesign needs a fresh controller mid-life.

***

### associationTornDown

> `protected` **associationTornDown**: `boolean` = `false`

True after association hard/graceful/fatal teardown so Public APIs stay
disabled for pure 1.2, pure 1.3, and dual paths alike (even if transport
close is still racing or engine13 has already been cleared).
Dual client also flips dualPhase=closed; this flag is the base guard.

***

### cipher

> **cipher**: [`CipherContext`](CipherContext.md)

***

### connected

> **connected**: `boolean` = `false`

***

### dtls

> **dtls**: `DtlsContext`

***

### engine13?

> `protected` `optional` **engine13**: `Dtls13Connection`

When set, DTLS 1.3 engine owns the transport and crypto state.

***

### extensions

> **extensions**: `Extension`[] = `[]`

***

### onClose

> `readonly` **onClose**: [`Event`](Event.md)\<`any`[]\>

***

### onConnect

> `readonly` **onConnect**: [`Event`](Event.md)\<`any`[]\>

***

### onData

> `readonly` **onData**: [`Event`](Event.md)\<\[`Buffer`\<`ArrayBufferLike`\>\]\>

***

### onError

> `readonly` **onError**: [`Event`](Event.md)\<\[`Error`\]\>

***

### onHandleHandshakes()

> **onHandleHandshakes**: (`assembled`, `peer`?) => `Promise`\<`void`\>

Assembled handshake handler. `peer` is the source of the datagram that
produced these messages (explicit UDP/inject addr) — async handlers must
reply to this address rather than reading mutable transport.rinfo.

#### Parameters

##### assembled

`FragmentedHandshake`[]

##### peer?

readonly \[`string`, `number`\]

#### Returns

`Promise`\<`void`\>

***

### options

> **options**: [`Options`](../interfaces/Options.md)

***

### protocolVersions

> `readonly` **protocolVersions**: [`DtlsVersion`](../enumerations/DtlsVersion.md)[]

Negotiated / configured protocol versions (priority order).

***

### sessionType

> **sessionType**: `SessionTypes`

***

### srtp

> **srtp**: [`SrtpContext`](SrtpContext.md)

***

### transport

> `readonly` **transport**: `TransportContext`

## Accessors

### isDtls13

#### Get Signature

> **get** **isDtls13**(): `boolean`

True when this socket is operating on the DTLS 1.3 engine.

##### Returns

`boolean`

***

### peerIdentityMode

#### Get Signature

> **get** **peerIdentityMode**(): [`PeerIdentityMode`](../type-aliases/PeerIdentityMode.md)

Resolved peer-identity policy for this association.
Prefer explicit [Options.peerIdentityMode](../interfaces/Options.md#peeridentitymode); otherwise infer from
transport.peerAuthenticated / addressValidation for backward compatibility.

##### Returns

[`PeerIdentityMode`](../type-aliases/PeerIdentityMode.md)

***

### remoteCertificate

#### Get Signature

> **get** **remoteCertificate**(): `undefined` \| `Buffer`\<`ArrayBufferLike`\>

##### Returns

`undefined` \| `Buffer`\<`ArrayBufferLike`\>

## Methods

### abortAssociationWaits()

> `protected` **abortAssociationWaits**(): `void`

Aborts association-owned async waits ([waitForReady](DtlsSocket.md#waitforready) sleeps).
Invoked on every terminal transition so pending timers/promises cancel
immediately (not only "wake later and check torn-down").

#### Returns

`void`

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

***

### assertReadyForApplicationApi()

> `protected` **assertReadyForApplicationApi**(`op`): `void`

Guard for send / exporter / remoteCertificate.
Dual client overrides to reject `closed` and `probing` (no 1.2 fallthrough).

#### Parameters

##### op

`string`

#### Returns

`void`

***

### bridgeEngine13()

> `protected` **bridgeEngine13**(`engine`, `options`?): `void`

Wire DTLS 1.3 engine events onto this socket.

#### Parameters

##### engine

`Dtls13Connection`

DTLS 1.3 connection to bridge.

##### options?

Optional bridge options. When `options.filterError` returns
  true, swallow the error (e.g. dual-stack version mismatch handled by
  transparent fallback without public onError).

###### filterError?

(`e`) => `boolean`

#### Returns

`void`

***

### cancelLegacy12FlightTimers()

> `protected` **cancelLegacy12FlightTimers**(): `void`

Cancel pending DTLS 1.2 flight retransmit sleeps only (leave flight number).
Use on successful handshake complete so Flight4/Flight5 sleep does not
linger until the next RTO after onConnect.

#### Returns

`void`

***

### clearSendPeerPin()

> `protected` **clearSendPeerPin**(): `void`

Clear TX pin on association terminal teardown.

#### Returns

`void`

***

### close()

> **close**(): `void`

#### Returns

`void`

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

***

### failAssociationFromEngine13()

> `protected` **failAssociationFromEngine13**(`_err`): `boolean`

Association-level fatal teardown after a non-soft 1.3 engine error.
Clears public engine13 (isDtls13 → false), stops bridge callbacks, and
hard-disposes candidate resources. HVR dual soft transition must not call
this (filterError swallows DtlsVersionSelected before we reach here).

Subclasses (dual client) override to also flip dualPhase → closed and
tear down parked candidates / 1.2 flight timers.

#### Parameters

##### \_err

`Error`

#### Returns

`boolean`

true when public onClose should be fired after onError (caller
  owns ordering so handlers observe isDtls13 === false first).

***

### failLegacy12Association()

> `protected` **failLegacy12Association**(`error`): `boolean`

Association-wide fatal teardown for DTLS 1.2 (TLS: immediate connection end).
Stops flight timers, clears connected, closes transport, disables Public API.
Dual client overrides to also set dualPhase=closed and close carrier/candidates.

#### Parameters

##### error

`Error`

#### Returns

`boolean`

true when the caller should fire public onClose after onError
  (same ordering as 1.3 [failAssociationFromEngine13](DtlsSocket.md#failassociationfromengine13)).

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

***

### handleFragmentHandshake()

> **handleFragmentHandshake**(`messages`): `FragmentedHandshake`[]

#### Parameters

##### messages

`FragmentedHandshake`[]

#### Returns

`FragmentedHandshake`[]

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

***

### hasAssociationPeerAuth()

> `protected` **hasAssociationPeerAuth**(): `boolean`

Peer-auth boundary for DTLS 1.2 association lifecycle (alerts / HS errors).

- UDP pin after cookie / connect (classic return-routability / datagram-address)
- authenticated-single-peer transport (ICE peerAuthenticated / ice-authenticated):
  AEAD-protected records must not be treated as "pre-auth" merely because
  the transport does not expose a 5-tuple (WebRTC IceTransport).

These modes are not interchangeable for TX routing (pin still owns UDP TX),
but either is sufficient for association-lifecycle alert decisions.

#### Returns

`boolean`

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

***

### isAuthenticatedSinglePeerTransport()

> `protected` **isAuthenticatedSinglePeerTransport**(): `boolean`

Transport path already authenticates a single peer (ICE / equivalent).
Distinct from TransportContext.pinnedPeer (UDP return-routability).
Driven by [peerIdentityMode](DtlsSocket.md#peeridentitymode) (public Options) when set.

#### Returns

`boolean`

***

### keyUpdate()

> **keyUpdate**(`requestUpdate`): `Promise`\<`void`\>

Request KeyUpdate on DTLS 1.3 connections.

#### Parameters

##### requestUpdate

`boolean` = `false`

#### Returns

`Promise`\<`void`\>

***

### matchesPinnedPeer()

> `protected` **matchesPinnedPeer**(`addr`?): `boolean`

True when inbound source matches association TX/RX pin, or no pin yet
(pre-cookie server / pre-connect). After pin, unknown or non-pin peer
must not drive handshake / app / alert lifecycle (RX ownership).

Peer-authentication vs address pin are separate:
- UDP 5-tuple pin: require matching source address when present
- authenticated-single-peer transport (ICE / peerAuthenticated): the
  transport path is the identity; addressless RX is accepted even if a
  pin was set for TX convenience (WebRTC does not pass rinfo into DTLS)

#### Parameters

##### addr?

readonly \[`string`, `number`\]

#### Returns

`boolean`

***

### onEngine13PeerOrLocalClose()

> `protected` **onEngine13PeerOrLocalClose**(): `void`

After engine onClose (peer close_notify or local engine close) has been
delivered publicly: drop the 1.3 handle. Dual client overrides to also
hard-close carrier / transport / candidates.

#### Returns

`void`

***

### onLegacy12PeerCloseNotify()

> `protected` **onLegacy12PeerCloseNotify**(): `void`

Peer close_notify on DTLS 1.2 path: sync terminal + best-effort reply with
a short send budget (same root cause as 1.3 hung transport.send).
Dual client overrides for phase/carrier/transport ownership.

#### Returns

`void`

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

***

### prepareAssociationClosedFromEngine()

> `protected` **prepareAssociationClosedFromEngine**(): `void`

Before public onClose for engine teardown: mark association closed so
re-entrant client.close() inside onClose handlers is idempotent and
Public APIs reject (send/exporter/cert) without 1.2 fallthrough.
Dual client also sets dualPhase → closed here.

#### Returns

`void`

***

### refragmentPendingFlightIfNeeded()

> **refragmentPendingFlightIfNeeded**(): `boolean`

Rebuild pending handshake datagrams under the current carrier MTU.
Used when SPED shrinks path MTU while retransmission mode is external.

#### Returns

`boolean`

***

### renegotiation()

> **renegotiation**(): `void`

#### Returns

`void`

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

***

### restorePinnedRinfo()

> `protected` **restorePinnedRinfo**(): `void`

Restore transport.rinfo to pin so spoof sources do not stick for later TX fallbacks.

#### Returns

`void`

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

***

### sendLegacy12CloseNotify()

> `protected` **sendLegacy12CloseNotify**(): `Promise`\<`void`\>

Best-effort close_notify on the current 1.2 write epoch.

#### Returns

`Promise`\<`void`\>

***

### sendPlaintextAlert()

> `protected` **sendPlaintextAlert**(`description`, `dest`?): `Promise`\<`void`\>

Send a fatal DTLSPlaintext alert (used for protocol_version mismatch).

#### Parameters

##### description

`number`

Alert description code.

##### dest?

readonly \[`string`, `number`\]

Explicit peer for this reply. Required pre-cookie so a concurrent
  spoof cannot redirect via mutable transport.rinfo; post-pin falls back to
  TransportContext.pinnedPeer when omitted.

#### Returns

`Promise`\<`void`\>

***

### setupExtensions()

> `protected` **setupExtensions**(): `void`

#### Returns

`void`

***

### udpOnMessage()

> `protected` **udpOnMessage**(`data`, `addr`?): `void`

#### Parameters

##### data

`Buffer`

##### addr?

readonly \[`string`, `number`\]

#### Returns

`void`

***

### unbridgeEngine13()

> `protected` **unbridgeEngine13**(): `void`

Drop bridge subscriptions for a disposed or replaced 1.3 candidate.

#### Returns

`void`

***

### waitForReady()

> `protected` **waitForReady**(`condition`): `Promise`\<`void`\>

#### Parameters

##### condition

() => `boolean`

#### Returns

`Promise`\<`void`\>

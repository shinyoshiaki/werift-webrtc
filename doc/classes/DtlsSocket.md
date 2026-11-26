[**werift**](../README.md)

***

[werift](../globals.md) / DtlsSocket

# Class: DtlsSocket

## Extended by

- [`DtlsClient`](DtlsClient.md)
- [`DtlsServer`](DtlsServer.md)

## Constructors

### Constructor

> **new DtlsSocket**(`options`, `sessionType`): `DtlsSocket`

#### Parameters

##### options

[`Options`](../interfaces/Options.md)

##### sessionType

`SessionTypes`

#### Returns

`DtlsSocket`

## Properties

### associationAbort

> `protected` **associationAbort**: `AbortController`

Cancels pending [waitForReady](#waitforready) association sleeps on terminal teardown.
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

### dtls

> **dtls**: `DtlsContext`

***

### engine13?

> `protected` `optional` **engine13?**: `Dtls13Connection`

When set, DTLS 1.3 engine owns the transport and crypto state.

***

### extensions

> **extensions**: `Extension`[] = `[]`

***

### onAlert

> `readonly` **onAlert**: [`Event`](Event.md)\<\[[`DtlsAlert`](../interfaces/DtlsAlert.md)\]\>

Fires for every alert received from the peer (before onClose / onError).

***

### onClose

> `readonly` **onClose**: [`Event`](Event.md)\<`any`[]\>

Fires once when the peer closed the connection with close_notify.

***

### onConnect

> `readonly` **onConnect**: [`Event`](Event.md)\<`any`[]\>

***

### onData

> `readonly` **onData**: [`Event`](Event.md)\<\[`Buffer`\<`ArrayBufferLike`\>\]\>

***

### onError

> `readonly` **onError**: [`Event`](Event.md)\<\[`Error`\]\>

Fires with a [DtlsAlertError](DtlsAlertError.md) when the connection ends with a fatal
alert (received from the peer, or sent by this side when it rejected the
peer certificate), and with other errors raised by the handshake.

***

### onHandleHandshakes

> **onHandleHandshakes**: (`assembled`, `peer?`, `meta?`) => `Promise`\<`void`\>

Assembled handshake handler. `peer` is the source of the datagram that
produced these messages (explicit UDP/inject addr) — async handlers must
reply to this address rather than reading mutable transport.rinfo.

#### Parameters

##### assembled

`FragmentedHandshake`[]

##### peer?

readonly \[`string`, `number`\]

##### meta?

[`DatagramRxMeta`](../interfaces/DatagramRxMeta.md)

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

***

### AlertSendTimeoutMs

> `static` **AlertSendTimeoutMs**: `number` = `200`

Default upper bound (ms) for waiting until an alert has been sent.

## Accessors

### connected

#### Get Signature

> **get** **connected**(): `boolean`

##### Returns

`boolean`

#### Set Signature

> **set** **connected**(`value`): `void`

##### Parameters

###### value

`boolean`

##### Returns

`void`

***

### handshakeStopped

#### Get Signature

> **get** `protected` **handshakeStopped**(): `boolean`

Whether this handshake must stop after a terminal alert or close.

##### Returns

`boolean`

***

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

> **get** **remoteCertificate**(): `Buffer`\<`ArrayBufferLike`\> \| `undefined`

##### Returns

`Buffer`\<`ArrayBufferLike`\> \| `undefined`

***

### terminated

#### Get Signature

> **get** **terminated**(): `boolean`

Whether the connection ended (alert, or close()).

##### Returns

`boolean`

## Methods

### abortAssociationWaits()

> `protected` **abortAssociationWaits**(): `void`

Aborts association-owned async waits ([waitForReady](#waitforready) sleeps).
Invoked on every terminal transition so pending timers/promises cancel
immediately (not only "wake later and check torn-down").

#### Returns

`void`

***

### abortLegacy12Flight()

> `protected` **abortLegacy12Flight**(`error?`): `void`

Abort legacy DTLS 1.2 flight: optional fatalError, flight=99, cancel timers.
Use on close / fatal alert / version commit away from 1.2 — not on
successful handshake complete (that only needs cancelLegacy12FlightTimers).

#### Parameters

##### error?

`Error`

#### Returns

`void`

***

### abortWithFatalAlert()

> `protected` **abortWithFatalAlert**(`description`, `reason?`): `void`

Abort the handshake (or the connection) because this side detected a
fatal error: see endWithFatalAlert.

#### Parameters

##### description

[`AlertDesc`](../enumerations/AlertDesc.md)

##### reason?

`unknown`

#### Returns

`void`

***

### alertFlushed()

> **alertFlushed**(): `Promise`\<`void`\>

Resolves once an in-flight alert has been handed to the transport.

#### Returns

`Promise`\<`void`\>

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

> `protected` **bridgeEngine13**(`engine`, `options?`): `void`

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

> **close**(`options?`): `Promise`\<`void`\>

Close this association. The Public API becomes terminal synchronously
(send() right after close() drops the data), before any await. DTLS 1.2
optionally sends close_notify first; an alert already handed to the
transport is flushed before the transport closes. A live DTLS 1.3 engine
sends its close_notify and closes the transport itself
(teardownAssociation), so it is not closed here.

#### Parameters

##### options?

###### notify?

`boolean`

###### timeoutMs?

`number`

#### Returns

`Promise`\<`void`\>

***

### closeLegacy12Association()

> `protected` **closeLegacy12Association**(`firePublicOnClose?`, `closeTransport?`): `void`

Local close for pure DTLS 1.2 (server and non-overridden paths).
Terminal transition + optional single public onClose (client dual uses
closeAssociationHard instead).

#### Parameters

##### firePublicOnClose?

`boolean` = `true`

##### closeTransport?

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

> **localKey**: `Buffer`\<`ArrayBufferLike`\> = `clientKey`

##### localSalt

> **localSalt**: `Buffer`\<`ArrayBufferLike`\> = `clientSalt`

##### remoteKey

> **remoteKey**: `Buffer`\<`ArrayBufferLike`\> = `serverKey`

##### remoteSalt

> **remoteSalt**: `Buffer`\<`ArrayBufferLike`\> = `serverSalt`

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

true when the association was torn down now (the caller fires
  onError afterwards, so handlers observe isDtls13 === false first).

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

true when the association was torn down now (false when it was
  already terminal), so the caller fires onError once.

***

### finishPeerCloseNotify()

> `protected` **finishPeerCloseNotify**(): `Promise`\<`void`\>

After the reply to the peer's close_notify was sent (or timed out):
fire onClose once and close the transport. The dual client overrides it
to also hard-close its 1.3 candidates and carrier.

#### Returns

`Promise`\<`void`\>

***

### handleFragmentHandshake()

> **handleFragmentHandshake**(`messages`, `epoch?`): `FragmentedHandshake`[]

Returns the handshake messages that `messages` (received in a record of
`epoch`) complete. Spec: `tests/server.test.ts` › "handleFragmentHandshake
returns a message only once every byte was received"

#### Parameters

##### messages

`FragmentedHandshake`[]

##### epoch?

`number` = `0`

#### Returns

`FragmentedHandshake`[]

***

### handleUdpDatagram()

> `protected` **handleUdpDatagram**(`data`, `addr?`, `meta?`): `void`

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

##### meta?

[`DatagramRxMeta`](../interfaces/DatagramRxMeta.md)

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

### invalidateLegacy12HandshakeOwnership()

> `protected` **invalidateLegacy12HandshakeOwnership**(): `void`

Invalidate legacy handshake callbacks that no longer own the association.
Used by dual-version selection and renegotiation before replacing the
lower-level state while keeping the public socket alive.

#### Returns

`void`

***

### isAuthenticatedLegacy12Record()

> `protected` **isAuthenticatedLegacy12Record**(`epoch`, `contentType`): `boolean`

After keys exist (connected or write epoch advanced), only epoch>0 records
are cryptographically authenticated for lifecycle alerts. Epoch-0 fatal /
close_notify must not tear down a post-handshake association (unauth DoS).

#### Parameters

##### epoch

`number`

##### contentType

`"alert"` \| `"handshake"` \| `"applicationData"`

#### Returns

`boolean`

***

### isAuthenticatedSinglePeerTransport()

> `protected` **isAuthenticatedSinglePeerTransport**(): `boolean`

Transport path already authenticates a single peer (ICE / equivalent).
Distinct from TransportContext.pinnedPeer (UDP return-routability).
Driven by [peerIdentityMode](#peeridentitymode) (public Options) when set.

#### Returns

`boolean`

***

### isCurrentRxGeneration()

> `protected` **isCurrentRxGeneration**(`rxGeneration?`): `boolean`

Check the carrier generation at every DTLS 1.2 receive boundary.

DTLS 1.3 performs this check again when its record queue resumes.  The
legacy path has asynchronous Flight handlers instead, so the association
must reject an old datagram both before parsing and after each await.  An
unset provider means this socket is being used by the standalone UDP API,
where no carrier generation exists and the check is intentionally disabled.

#### Parameters

##### rxGeneration?

`number`

#### Returns

`boolean`

***

### keyUpdate()

> **keyUpdate**(`requestUpdate?`): `Promise`\<`void`\>

Request KeyUpdate on DTLS 1.3 connections.

#### Parameters

##### requestUpdate?

`boolean` = `false`

#### Returns

`Promise`\<`void`\>

***

### markEndedByLocalClose()

> `protected` **markEndedByLocalClose**(): `void`

A local close() ended the connection: received records are no longer
processed and no handshake flight is (re)sent.

#### Returns

`void`

***

### matchesPinnedPeer()

> `protected` **matchesPinnedPeer**(`addr?`): `boolean`

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

### notify()

> `protected` **notify**\<`T`\>(`event`, ...`args`): `void`

Run the listeners of an event this socket reports, each isolated
(`Event.executeIsolated`): a listener's exception is logged, so an
application listener can never interrupt the socket's own processing
(ending the connection, closing the transport, the receive loop) nor
skip a listener registered after it.

#### Type Parameters

##### T

`T` *extends* `any`[]

#### Parameters

##### event

[`Event`](Event.md)\<`T`\>

##### args

...`T`

#### Returns

`void`

***

### notifyEngine13Selected()

> `protected` **notifyEngine13Selected**(): `void`

Notify association-level readiness waiters that DTLS 1.3 is active.

A dual-stack client can resume a parked candidate without rebuilding its
event bridge, so that path must share the same selection notification as a
freshly created engine.

#### Returns

`void`

***

### onEngine13PeerOrLocalClose()

> `protected` **onEngine13PeerOrLocalClose**(): `void`

After engine onClose (peer close_notify or local engine close) has been
delivered publicly: drop the 1.3 handle. Dual client overrides to also
hard-close carrier / transport / candidates.

#### Returns

`void`

***

### ownsLegacy12Handshake()

> `protected` **ownsLegacy12Handshake**(`ownership`, `rxGeneration`, `peer?`): `boolean`

Check ownership before an asynchronous legacy handshake rejection is
allowed to change association state.

The receive path validates these conditions before starting the async
handler, but a later rejection resumes outside that synchronous boundary.
A DTLS 1.2 handler from an old ICE generation, a released dual candidate,
or a changed peer pin must be discarded instead of failing the current
association.

#### Parameters

##### ownership

`number`

##### rxGeneration

`number` \| `undefined`

##### peer?

readonly \[`string`, `number`\]

#### Returns

`boolean`

***

### pinSendPeer()

> `protected` **pinSendPeer**(`addr?`, `mode?`): `void`

Normalize and store association TX peer pin on TransportContext.

Why association-owned: UdpTransport.rinfo is overwritten by every inbound
datagram (including spoof). Flight retransmit and application send must not
follow last-rinfo alone (ticket peer-pinning / TX ownership).

#### Parameters

##### addr?

readonly \[`string`, `number`\]

##### mode?

`"replace"` \| `"set-if-empty"` = `"set-if-empty"`

`set-if-empty` keeps the first authenticated pin (server Flight4 /
  connect). `replace` is for dual association re-pin / client connect.

#### Returns

`void`

***

### pinSendPeerFromTransportRinfo()

> `protected` **pinSendPeerFromTransportRinfo**(`mode?`): `void`

Pin from last transport rinfo when present.
Default mode is `set-if-empty` (keeps an existing authenticated pin).
Pass `replace` when the association deliberately re-pins (e.g. client connect).

#### Parameters

##### mode?

`"replace"` \| `"set-if-empty"` = `"set-if-empty"`

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

### renegotiation()

> **renegotiation**(): `void`

#### Returns

`void`

***

### reportLegacy12Fatal()

> `protected` **reportLegacy12Fatal**(`error`): `void`

Tear down the 1.2 association then fire onError once (no onClose: it is
reserved for close_notify and a local close()).
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

> `protected` **resolveInboundPeer**(`addr?`): readonly \[`string`, `number`\] \| `undefined`

Resolve inbound peer for RX ownership: explicit UDP/inject addr first,
else last transport rinfo (may be spoofed — always gate with pin).

#### Parameters

##### addr?

readonly \[`string`, `number`\]

#### Returns

readonly \[`string`, `number`\] \| `undefined`

***

### restorePinnedRinfo()

> `protected` **restorePinnedRinfo**(): `void`

Restore transport.rinfo to pin so spoof sources do not stick for later TX fallbacks.

#### Returns

`void`

***

### send()

> **send**(`buf`, `addr?`): `Promise`\<`void`\>

send application data

#### Parameters

##### buf

`Buffer`

##### addr?

readonly \[`string`, `number`\]

#### Returns

`Promise`\<`void`\>

***

### sendAlert()

> **sendAlert**(`level`, `description`, `options?`): `Promise`\<`void`\>

Send an alert to the peer, protected with the current epoch (plaintext
before ChangeCipherSpec, encrypted after it).

Resolves once the transport has sent the record, or after `timeoutMs`
(default [DtlsSocket.AlertSendTimeoutMs](#alertsendtimeoutms)). It never rejects: a
failed send is only logged. Nothing is sent once close_notify or a fatal
alert has been sent or the transport is closed. Sending close_notify or a
fatal alert also stops the handshake flights (no retransmission). The
record is handed to the transport synchronously, so closing the socket
right after calling this does not drop it.

A fatal alert ends the connection like a fatal error this side detected
itself: `onError` fires synchronously with a local [DtlsAlertError](DtlsAlertError.md),
and the transport is closed once the alert has been sent (the returned
promise resolves after that).

#### Parameters

##### level

[`AlertLevel`](../enumerations/AlertLevel.md)

##### description

[`AlertDesc`](../enumerations/AlertDesc.md)

##### options?

###### timeoutMs?

`number`

#### Returns

`Promise`\<`void`\>

***

### sendPlaintextAlert()

> `protected` **sendPlaintextAlert**(`description`, `dest?`): `Promise`\<`void`\>

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

> `protected` **udpOnMessage**(`data`, `addr?`, `meta?`): `void`

#### Parameters

##### data

`Buffer`

##### addr?

readonly \[`string`, `number`\]

##### meta?

[`DatagramRxMeta`](../interfaces/DatagramRxMeta.md)

#### Returns

`void`

***

### unbridgeEngine13()

> `protected` **unbridgeEngine13**(): `void`

Drop bridge subscriptions for a disposed or replaced 1.3 candidate.

#### Returns

`void`

***

### verifyRemoteCertificate()

> `protected` **verifyRemoteCertificate**(): `boolean`

Call `options.verifyRemoteCertificate` with the received peer
certificate. When it returns false or throws, the handshake is aborted
with a fatal bad_certificate alert and false is returned.

#### Returns

`boolean`

***

### waitForReady()

> `protected` **waitForReady**(`condition`): `Promise`\<`void`\>

#### Parameters

##### condition

() => `boolean`

#### Returns

`Promise`\<`void`\>

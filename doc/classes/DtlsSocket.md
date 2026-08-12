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

### associationTornDown

> `protected` **associationTornDown**: `boolean` = `false`

True after DTLS 1.2 association hard/graceful teardown so pure-1.2 Public
APIs stay disabled even if transport close is still racing.
Dual client primarily uses dualPhase=closed; this flag is the base guard.

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

> **onHandleHandshakes**: (`assembled`) => `Promise`\<`void`\>

#### Parameters

##### assembled

`FragmentedHandshake`[]

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

### remoteCertificate

#### Get Signature

> **get** **remoteCertificate**(): `undefined` \| `Buffer`\<`ArrayBufferLike`\>

##### Returns

`undefined` \| `Buffer`\<`ArrayBufferLike`\>

## Methods

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

##### options?

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

### close()

> **close**(): `void`

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

### handleFragmentHandshake()

> **handleFragmentHandshake**(`messages`): `FragmentedHandshake`[]

#### Parameters

##### messages

`FragmentedHandshake`[]

#### Returns

`FragmentedHandshake`[]

***

### handleUdpDatagram()

> `protected` **handleUdpDatagram**(`data`): `void`

Process one UDP datagram on the DTLS 1.2 record path.
Subclasses (dual client) may intercept before calling this.

#### Parameters

##### data

`Buffer`

#### Returns

`void`

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

Peer close_notify on DTLS 1.2 path: best-effort reply, then graceful
association close (connected=false, timers cancel, onClose, transport).
Dual client overrides for phase/carrier/transport ownership.

#### Returns

`void`

***

### prepareAssociationClosedFromEngine()

> `protected` **prepareAssociationClosedFromEngine**(): `void`

Before public onClose for engine teardown: mark association closed so
re-entrant client.close() inside onClose handlers is idempotent.
Dual client sets dualPhase → closed here.

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

Tear down the 1.2 association then fire onError (and onClose when teardown ran).
Used for fatal alerts, probing DOWNGRD / classify error, and other 1.2
ProtocolVersionError paths so lifecycle matches handshake_failure alerts.

#### Parameters

##### error

`Error`

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

> `protected` **sendPlaintextAlert**(`description`): `Promise`\<`void`\>

Send a fatal DTLSPlaintext alert (used for protocol_version mismatch).

#### Parameters

##### description

`number`

#### Returns

`Promise`\<`void`\>

***

### setupExtensions()

> `protected` **setupExtensions**(): `void`

#### Returns

`void`

***

### udpOnMessage()

> `protected` **udpOnMessage**(`data`, `_addr`?): `void`

#### Parameters

##### data

`Buffer`

##### \_addr?

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

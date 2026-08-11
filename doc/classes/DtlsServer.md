[**werift**](../README.md)

***

[werift](../globals.md) / DtlsServer

# Class: DtlsServer

## Extends

- [`DtlsSocket`](DtlsSocket.md)

## Constructors

### new DtlsServer()

> **new DtlsServer**(`options`): [`DtlsServer`](DtlsServer.md)

Public constructor — accepts stable [Options](../interfaces/Options.md) only.

#### Parameters

##### options

[`Options`](../interfaces/Options.md)

#### Returns

[`DtlsServer`](DtlsServer.md)

#### Overrides

[`DtlsSocket`](DtlsSocket.md).[`constructor`](DtlsSocket.md#constructors)

## Properties

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

### assertReadyForApplicationApi()

> `protected` **assertReadyForApplicationApi**(`_op`): `void`

Guard for send / exporter / remoteCertificate.
Dual client overrides to reject `closed` and `probing` (no 1.2 fallthrough).

#### Parameters

##### \_op

`string`

#### Returns

`void`

#### Inherited from

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

### close()

> **close**(): `void`

#### Returns

`void`

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`close`](DtlsSocket.md#close)

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

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`failAssociationFromEngine13`](DtlsSocket.md#failassociationfromengine13)

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

> `protected` **handleUdpDatagram**(`data`): `void`

Process one UDP datagram on the DTLS 1.2 record path.
Subclasses (dual client) may intercept before calling this.

#### Parameters

##### data

`Buffer`

#### Returns

`void`

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`handleUdpDatagram`](DtlsSocket.md#handleudpdatagram)

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

### onEngine13PeerOrLocalClose()

> `protected` **onEngine13PeerOrLocalClose**(): `void`

After engine onClose (peer close_notify or local engine close) has been
delivered publicly: drop the 1.3 handle. Dual client overrides to also
hard-close carrier / transport / candidates.

#### Returns

`void`

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`onEngine13PeerOrLocalClose`](DtlsSocket.md#onengine13peerorlocalclose)

***

### prepareAssociationClosedFromEngine()

> `protected` **prepareAssociationClosedFromEngine**(): `void`

Before public onClose for engine teardown: mark association closed so
re-entrant client.close() inside onClose handlers is idempotent.
Dual client sets dualPhase → closed here.

#### Returns

`void`

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`prepareAssociationClosedFromEngine`](DtlsSocket.md#prepareassociationclosedfromengine)

***

### renegotiation()

> **renegotiation**(): `void`

#### Returns

`void`

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`renegotiation`](DtlsSocket.md#renegotiation)

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

> `protected` **udpOnMessage**(`data`, `_addr`?): `void`

#### Parameters

##### data

`Buffer`

##### \_addr?

readonly \[`string`, `number`\]

#### Returns

`void`

#### Inherited from

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

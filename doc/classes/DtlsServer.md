[**werift**](../README.md)

***

[werift](../globals.md) / DtlsServer

# Class: DtlsServer

## Extends

- [`DtlsSocket`](DtlsSocket.md)

## Constructors

### Constructor

> **new DtlsServer**(`options`): `DtlsServer`

#### Parameters

##### options

[`DtlsSocketOptions`](../interfaces/DtlsSocketOptions.md)

#### Returns

`DtlsServer`

#### Overrides

[`DtlsSocket`](DtlsSocket.md).[`constructor`](DtlsSocket.md#constructor)

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

### extensions

> **extensions**: `Extension`[] = `[]`

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`extensions`](DtlsSocket.md#extensions)

***

### onAlert

> `readonly` **onAlert**: [`Event`](Event.md)\<\[[`DtlsAlert`](../interfaces/DtlsAlert.md)\]\>

Fires for every alert received from the peer (before onClose / onError).

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`onAlert`](DtlsSocket.md#onalert)

***

### onClose

> `readonly` **onClose**: [`Event`](Event.md)\<`any`[]\>

Fires once when the peer closed the connection with close_notify.

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

Fires with a [DtlsAlertError](DtlsAlertError.md) when the connection ends with a fatal
alert (received from the peer, or sent by this side when it rejected the
peer certificate), and with other errors raised by the handshake.

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`onError`](DtlsSocket.md#onerror)

***

### onHandleHandshakes

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

> **options**: [`DtlsSocketOptions`](../interfaces/DtlsSocketOptions.md)

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`options`](DtlsSocket.md#options)

***

### sessionType

> **sessionType**: `SessionTypes`

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`sessionType`](DtlsSocket.md#sessiontype)

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

***

### AlertSendTimeoutMs

> `static` **AlertSendTimeoutMs**: `number` = `200`

Default upper bound (ms) for waiting until an alert has been sent.

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`AlertSendTimeoutMs`](DtlsSocket.md#alertsendtimeoutms)

## Accessors

### remoteCertificate

#### Get Signature

> **get** **remoteCertificate**(): `Buffer`\<`ArrayBufferLike`\> \| `undefined`

##### Returns

`Buffer`\<`ArrayBufferLike`\> \| `undefined`

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`remoteCertificate`](DtlsSocket.md#remotecertificate)

***

### terminated

#### Get Signature

> **get** **terminated**(): `boolean`

Whether the connection ended (alert, or close()).

##### Returns

`boolean`

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`terminated`](DtlsSocket.md#terminated)

## Methods

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

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`abortWithFatalAlert`](DtlsSocket.md#abortwithfatalalert)

***

### alertFlushed()

> **alertFlushed**(): `Promise`\<`void`\>

Resolves once the alert being sent (e.g. the close_notify answering the
peer's) has been handed to the transport or timed out. Resolves
immediately when none is in flight. Never rejects.

#### Returns

`Promise`\<`void`\>

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`alertFlushed`](DtlsSocket.md#alertflushed)

***

### close()

> **close**(`options?`): `Promise`\<`void`\>

Close the socket: received records are no longer processed and a
handshake flight stops retransmitting.

- `close()`: closes the transport immediately, without alert (unchanged
  behavior).
- `close({ notify: true })`: sends close_notify first and closes the
  transport once it has been sent, or after `timeoutMs`
  (default [DtlsSocket.AlertSendTimeoutMs](DtlsSocket.md#alertsendtimeoutms)).

The returned promise resolves once the transport is closed and never
rejects.

#### Parameters

##### options?

###### notify?

`boolean`

###### timeoutMs?

`number`

#### Returns

`Promise`\<`void`\>

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`close`](DtlsSocket.md#close)

***

### exportKeyingMaterial()

> **exportKeyingMaterial**(`label`, `length`): `Buffer`\<`ArrayBuffer`\>

#### Parameters

##### label

`string`

##### length

`number`

#### Returns

`Buffer`\<`ArrayBuffer`\>

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

> **localKey**: `Buffer`\<`ArrayBufferLike`\> = `clientKey`

##### localSalt

> **localSalt**: `Buffer`\<`ArrayBufferLike`\> = `clientSalt`

##### remoteKey

> **remoteKey**: `Buffer`\<`ArrayBufferLike`\> = `serverKey`

##### remoteSalt

> **remoteSalt**: `Buffer`\<`ArrayBufferLike`\> = `serverSalt`

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`extractSessionKeys`](DtlsSocket.md#extractsessionkeys)

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

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`notify`](DtlsSocket.md#notify)

***

### renegotiation()

> **renegotiation**(): `void`

#### Returns

`void`

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`renegotiation`](DtlsSocket.md#renegotiation)

***

### send()

> **send**(`buf`, `addr?`): `Promise`\<`void`\>

send application data. Nothing is sent once close_notify or a fatal
alert has been sent or received.

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

### sendAlert()

> **sendAlert**(`level`, `description`, `options?`): `Promise`\<`void`\>

Send an alert to the peer, protected with the current epoch (plaintext
before ChangeCipherSpec, encrypted after it).

Resolves once the transport has sent the record, or after `timeoutMs`
(default [DtlsSocket.AlertSendTimeoutMs](DtlsSocket.md#alertsendtimeoutms)). It never rejects: a
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

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`sendAlert`](DtlsSocket.md#sendalert)

***

### verifyRemoteCertificate()

> `protected` **verifyRemoteCertificate**(): `boolean`

Call `options.verifyRemoteCertificate` with the received peer
certificate. When it returns false or throws, the handshake is aborted
with a fatal bad_certificate alert and false is returned.

#### Returns

`boolean`

#### Inherited from

[`DtlsSocket`](DtlsSocket.md).[`verifyRemoteCertificate`](DtlsSocket.md#verifyremotecertificate)

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

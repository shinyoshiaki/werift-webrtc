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

[`DtlsSocketOptions`](../interfaces/DtlsSocketOptions.md)

##### sessionType

`SessionTypes`

#### Returns

`DtlsSocket`

## Properties

### cipher

> **cipher**: [`CipherContext`](CipherContext.md)

***

### connected

> **connected**: `boolean` = `false`

***

### dtls

> **dtls**: `DtlsContext`

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

> **onHandleHandshakes**: (`assembled`) => `Promise`\<`void`\>

#### Parameters

##### assembled

`FragmentedHandshake`[]

#### Returns

`Promise`\<`void`\>

***

### options

> **options**: [`DtlsSocketOptions`](../interfaces/DtlsSocketOptions.md)

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

### abortWithFatalAlert()

> `protected` **abortWithFatalAlert**(`description`, `reason?`): `void`

Abort the handshake (or the connection) because this side detected a
fatal error: send the fatal alert, stop the flights, report a local
[DtlsAlertError](DtlsAlertError.md) on onError, and close the transport once the alert
has been sent.

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

Resolves once the alert being sent (e.g. the close_notify answering the
peer's) has been handed to the transport or timed out. Resolves
immediately when none is in flight. Never rejects.

#### Returns

`Promise`\<`void`\>

***

### close()

> **close**(`options?`): `Promise`\<`void`\>

Close the socket: received records are no longer processed and a
handshake flight stops retransmitting.

- `close()`: closes the transport immediately, without alert (unchanged
  behavior).
- `close({ notify: true })`: sends close_notify first and closes the
  transport once it has been sent, or after `timeoutMs`
  (default [DtlsSocket.AlertSendTimeoutMs](#alertsendtimeoutms)).

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

### handleFragmentHandshake()

> **handleFragmentHandshake**(`messages`): `FragmentedHandshake`[]

#### Parameters

##### messages

`FragmentedHandshake`[]

#### Returns

`FragmentedHandshake`[]

***

### renegotiation()

> **renegotiation**(): `void`

#### Returns

`void`

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

***

### sendAlert()

> **sendAlert**(`level`, `description`, `options?`): `Promise`\<`void`\>

Send an alert to the peer, protected with the current epoch (plaintext
before ChangeCipherSpec, encrypted after it).

Resolves once the transport has sent the record, or after `timeoutMs`
(default [DtlsSocket.AlertSendTimeoutMs](#alertsendtimeoutms)). It never rejects: a
failed send is only logged. Nothing is sent once close_notify or a fatal
alert has been sent or the transport is closed. Sending close_notify or a
fatal alert also stops the handshake flights (no retransmission). The record is handed to
the transport synchronously, so closing the socket right after calling
this does not drop it.

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

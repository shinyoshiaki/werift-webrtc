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

`Options`

##### sessionType

`SessionTypes`

#### Returns

[`DtlsSocket`](DtlsSocket.md)

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

> **options**: `Options`

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

### remoteCertificate

#### Get Signature

> **get** **remoteCertificate**(): `undefined` \| `Buffer`\<`ArrayBufferLike`\>

##### Returns

`undefined` \| `Buffer`\<`ArrayBufferLike`\>

## Methods

### close()

> **close**(): `void`

#### Returns

`void`

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

> **localKey**: `any` = `clientKey`

##### localSalt

> **localSalt**: `any` = `clientSalt`

##### remoteKey

> **remoteKey**: `any` = `serverKey`

##### remoteSalt

> **remoteSalt**: `any` = `serverSalt`

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

> **send**(`buf`): `Promise`\<`void`\>

send application data

#### Parameters

##### buf

`Buffer`

#### Returns

`Promise`\<`void`\>

***

### waitForReady()

> `protected` **waitForReady**(`condition`): `Promise`\<`void`\>

#### Parameters

##### condition

() => `boolean`

#### Returns

`Promise`\<`void`\>

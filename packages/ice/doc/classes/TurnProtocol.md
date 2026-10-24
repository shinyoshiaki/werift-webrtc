[**werift-ice**](../README.md)

***

[werift-ice](../globals.md) / TurnProtocol

# Class: TurnProtocol

## Implements

- [`Protocol`](../interfaces/Protocol.md)

## Constructors

### Constructor

> **new TurnProtocol**(`server`, `username`, `password`, `lifetime`, `transport`, `options?`): `TurnProtocol`

#### Parameters

##### server

readonly \[`string`, `number`\]

TURN server the allocation is made on; the host may be a hostname.
Starts as the configured server and becomes the ALTERNATE-SERVER when
an Allocate is redirected with 300 (Try Alternate).

##### username

`string`

##### password

`string`

##### lifetime

`number`

##### transport

`Transport`

##### options?

###### channelRefreshTime?

`number`

sec

###### maxAllocateRedirects?

`number`

300 (Try Alternate) redirects followed for one Allocate.
Defaults to 3.

###### reconnect?

[`TurnStreamReconnect`](../type-aliases/TurnStreamReconnect.md)

Reconnects a TCP/TLS transport to an ALTERNATE-SERVER. Without it, a
redirect over a stream transport fails with TurnRedirectError
("unsupported-transport"). UDP needs no reconnect.

#### Returns

`TurnProtocol`

## Properties

### configuredServer

> `readonly` **configuredServer**: readonly \[`string`, `number`\]

TURN server as configured, before any 300 (Try Alternate) redirect.

***

### integrityKey?

> `optional` **integrityKey?**: `Buffer`\<`ArrayBufferLike`\>

***

### lifetime

> **lifetime**: `number`

***

### localCandidate

> **localCandidate**: [`Candidate`](Candidate.md)

#### Implementation of

[`Protocol`](../interfaces/Protocol.md).[`localCandidate`](../interfaces/Protocol.md#localcandidate)

***

### mappedAddress

> **mappedAddress**: readonly \[`string`, `number`\]

***

### nonce?

> `optional` **nonce?**: `Buffer`\<`ArrayBufferLike`\>

***

### onData

> `readonly` **onData**: `Event`\<\[`Buffer`\<`ArrayBufferLike`\>, readonly \[`string`, `number`\]\]\>

***

### onDataReceived

> **onDataReceived**: `Event`\<\[`Buffer`\<`ArrayBufferLike`\>\]\>

#### Implementation of

[`Protocol`](../interfaces/Protocol.md).[`onDataReceived`](../interfaces/Protocol.md#ondatareceived)

***

### onRequestReceived

> **onRequestReceived**: `Event`\<\[[`Message`](Message.md), readonly \[`string`, `number`\], `Buffer`\<`ArrayBufferLike`\>\]\>

#### Implementation of

[`Protocol`](../interfaces/Protocol.md).[`onRequestReceived`](../interfaces/Protocol.md#onrequestreceived)

***

### options

> **options**: `object` = `{}`

#### channelRefreshTime?

> `optional` **channelRefreshTime?**: `number`

sec

#### maxAllocateRedirects?

> `optional` **maxAllocateRedirects?**: `number`

300 (Try Alternate) redirects followed for one Allocate.
Defaults to 3.

#### reconnect?

> `optional` **reconnect?**: [`TurnStreamReconnect`](../type-aliases/TurnStreamReconnect.md)

Reconnects a TCP/TLS transport to an ALTERNATE-SERVER. Without it, a
redirect over a stream transport fails with TurnRedirectError
("unsupported-transport"). UDP needs no reconnect.

***

### password

> **password**: `string`

***

### realm?

> `optional` **realm?**: `string`

***

### relayedAddress

> **relayedAddress**: readonly \[`string`, `number`\]

***

### server

> **server**: readonly \[`string`, `number`\]

TURN server the allocation is made on; the host may be a hostname.
Starts as the configured server and becomes the ALTERNATE-SERVER when
an Allocate is redirected with 300 (Try Alternate).

***

### transactions

> **transactions**: `object` = `{}`

#### Index Signature

\[`hexId`: `string`\]: `Transaction`

***

### transport

> **transport**: `Transport`

***

### type

> `readonly` **type**: `string` = `TurnProtocol.type`

#### Implementation of

[`Protocol`](../interfaces/Protocol.md).[`type`](../interfaces/Protocol.md#type)

***

### username

> **username**: `string`

***

### type

> `static` **type**: `string` = `"turn"`

## Accessors

### serverEndpoint

#### Get Signature

> **get** **serverEndpoint**(): readonly \[`string`, `number`\] \| `undefined`

The concrete TURN server address, selected on the first request and
pinned for the rest of the allocation, so a later DNS answer can never
move REFRESH, CREATE_PERMISSION, CHANNEL_BIND or data to another server.

##### Returns

readonly \[`string`, `number`\] \| `undefined`

## Methods

### close()

> **close**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`Protocol`](../interfaces/Protocol.md).[`close`](../interfaces/Protocol.md#close)

***

### connectionMade()

> **connectionMade**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`Protocol`](../interfaces/Protocol.md).[`connectionMade`](../interfaces/Protocol.md#connectionmade)

***

### getChannel()

> **getChannel**(`addr`): `Promise`\<[`TurnChannel`](../interfaces/TurnChannel.md)\>

Ensure a ChannelBind exists for the peer transport address.
Peer failures are isolated; concurrent same-peer calls share one Promise.

#### Parameters

##### addr

readonly \[`string`, `number`\]

#### Returns

`Promise`\<[`TurnChannel`](../interfaces/TurnChannel.md)\>

***

### getPermission()

> **getPermission**(`addr`): `Promise`\<`void`\>

Ensure a CreatePermission exists for the peer IP.
Peer failures are isolated: a rejection for peer A does not poison peer B.

#### Parameters

##### addr

readonly \[`string`, `number`\]

#### Returns

`Promise`\<`void`\>

***

### request()

> **request**(`request`, `addr`, `_integrityKey?`, `retransmissionsOrOptions?`, `onRequestSent?`): `Promise`\<\[[`Message`](Message.md), readonly \[`string`, `number`\]\]\>

#### Parameters

##### request

[`Message`](Message.md)

##### addr

readonly \[`string`, `number`\]

##### \_integrityKey?

`Buffer`\<`ArrayBufferLike`\>

##### retransmissionsOrOptions?

`number` \| [`TransactionRequestOptions`](../interfaces/TransactionRequestOptions.md)

##### onRequestSent?

(`attempt`) => `void`

#### Returns

`Promise`\<\[[`Message`](Message.md), readonly \[`string`, `number`\]\]\>

#### Implementation of

[`Protocol`](../interfaces/Protocol.md).[`request`](../interfaces/Protocol.md#request)

***

### requestWithRetry()

> **requestWithRetry**(`request`, `addr`, `signal?`): `Promise`\<\[[`Message`](Message.md), readonly \[`string`, `number`\]\]\>

#### Parameters

##### request

[`Message`](Message.md)

##### addr

readonly \[`string`, `number`\]

##### signal?

`AbortSignal`

#### Returns

`Promise`\<\[[`Message`](Message.md), readonly \[`string`, `number`\]\]\>

***

### sendData()

> **sendData**(`data`, `addr`): `Promise`\<`void`\>

#### Parameters

##### data

`Buffer`

##### addr

readonly \[`string`, `number`\]

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`Protocol`](../interfaces/Protocol.md).[`sendData`](../interfaces/Protocol.md#senddata)

***

### sendStun()

> **sendStun**(`message`, `addr`): `Promise`\<`void`\>

#### Parameters

##### message

[`Message`](Message.md)

##### addr

readonly \[`string`, `number`\]

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`Protocol`](../interfaces/Protocol.md).[`sendStun`](../interfaces/Protocol.md#sendstun)

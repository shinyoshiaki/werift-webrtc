[**werift-ice**](../README.md)

***

[werift-ice](../globals.md) / TcpPassiveProtocol

# Class: TcpPassiveProtocol

## Extends

- `BaseTcpProtocol`

## Constructors

### new TcpPassiveProtocol()

> **new TcpPassiveProtocol**(): [`TcpPassiveProtocol`](TcpPassiveProtocol.md)

#### Returns

[`TcpPassiveProtocol`](TcpPassiveProtocol.md)

#### Inherited from

`BaseTcpProtocol.constructor`

## Properties

### localCandidate?

> `optional` **localCandidate**: [`Candidate`](Candidate.md)

#### Inherited from

`BaseTcpProtocol.localCandidate`

***

### localIp?

> `optional` **localIp**: `string`

#### Inherited from

`BaseTcpProtocol.localIp`

***

### onDataReceived

> `readonly` **onDataReceived**: `Event`\<\[`Buffer`\<`ArrayBufferLike`\>, readonly \[`string`, `number`\]?\]\>

#### Inherited from

`BaseTcpProtocol.onDataReceived`

***

### onRequestReceived

> `readonly` **onRequestReceived**: `Event`\<\[[`Message`](Message.md), readonly \[`string`, `number`\], `Buffer`\<`ArrayBufferLike`\>\]\>

#### Inherited from

`BaseTcpProtocol.onRequestReceived`

***

### sentMessage?

> `optional` **sentMessage**: [`Message`](Message.md)

#### Inherited from

`BaseTcpProtocol.sentMessage`

***

### sockets

> `protected` `readonly` **sockets**: `Map`\<`string`, `SocketEntry`\>

#### Inherited from

`BaseTcpProtocol.sockets`

***

### transactions

> **transactions**: `object` = `{}`

#### Index Signature

\[`key`: `string`\]: `Transaction`

#### Inherited from

`BaseTcpProtocol.transactions`

***

### type

> `readonly` **type**: `"tcp"` = `BaseTcpProtocol.type`

#### Inherited from

`BaseTcpProtocol.type`

***

### type

> `readonly` `static` **type**: `"tcp"` = `"tcp"`

#### Inherited from

`BaseTcpProtocol.type`

## Accessors

### activeSocketCount

#### Get Signature

> **get** **activeSocketCount**(): `number`

##### Returns

`number`

#### Inherited from

`BaseTcpProtocol.activeSocketCount`

***

### address

#### Get Signature

> **get** **address**(): `AddressInfo`

##### Returns

`AddressInfo`

#### Inherited from

`BaseTcpProtocol.address`

***

### listeningPort

#### Get Signature

> **get** **listeningPort**(): `number`

##### Returns

`number`

## Methods

### close()

> **close**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

#### Overrides

`BaseTcpProtocol.close`

***

### connectionMade()

> **connectionMade**(`localIp`, `portRange`?): `Promise`\<`void`\>

#### Parameters

##### localIp

`string`

##### portRange?

\[`number`, `number`\]

#### Returns

`Promise`\<`void`\>

#### Overrides

`BaseTcpProtocol.connectionMade`

***

### forgetSocket()

> `protected` **forgetSocket**(`remoteAddr`?): `void`

#### Parameters

##### remoteAddr?

readonly \[`string`, `number`\]

#### Returns

`void`

#### Inherited from

`BaseTcpProtocol.forgetSocket`

***

### getSocket()

> `protected` **getSocket**(`addr`): `Promise`\<`SocketEntry`\>

#### Parameters

##### addr

readonly \[`string`, `number`\]

#### Returns

`Promise`\<`SocketEntry`\>

#### Overrides

`BaseTcpProtocol.getSocket`

***

### pruneForSelection()

> **pruneForSelection**(`remoteAddr`?): `Promise`\<`void`\>

#### Parameters

##### remoteAddr?

readonly \[`string`, `number`\]

#### Returns

`Promise`\<`void`\>

#### Inherited from

`BaseTcpProtocol.pruneForSelection`

***

### registerSocket()

> `protected` **registerSocket**(`socket`, `remoteAddr`?): `SocketEntry`

#### Parameters

##### socket

`Socket`

##### remoteAddr?

readonly \[`string`, `number`\]

#### Returns

`SocketEntry`

#### Inherited from

`BaseTcpProtocol.registerSocket`

***

### rememberSocket()

> `protected` **rememberSocket**(`entry`): `void`

#### Parameters

##### entry

`SocketEntry`

#### Returns

`void`

#### Inherited from

`BaseTcpProtocol.rememberSocket`

***

### request()

> **request**(`request`, `addr`, `integrityKey`?, `retransmissionsOrOptions`?, `onRequestSent`?): `Promise`\<\[[`Message`](Message.md), readonly \[`string`, `number`\]\]\>

#### Parameters

##### request

[`Message`](Message.md)

##### addr

readonly \[`string`, `number`\]

##### integrityKey?

`Buffer`\<`ArrayBufferLike`\>

##### retransmissionsOrOptions?

`number` | [`TransactionRequestOptions`](../interfaces/TransactionRequestOptions.md)

##### onRequestSent?

(`attempt`) => `void`

#### Returns

`Promise`\<\[[`Message`](Message.md), readonly \[`string`, `number`\]\]\>

#### Inherited from

`BaseTcpProtocol.request`

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

#### Inherited from

`BaseTcpProtocol.sendData`

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

#### Inherited from

`BaseTcpProtocol.sendStun`

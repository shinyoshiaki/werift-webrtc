[**werift**](../README.md)

***

[werift](../globals.md) / UdpTransport

# Class: UdpTransport

## Implements

- [`Transport`](../interfaces/Transport.md)

## Properties

### closed

> **closed**: `boolean` = `false`

#### Implementation of

[`Transport`](../interfaces/Transport.md).[`closed`](../interfaces/Transport.md#closed)

***

### onData()

> **onData**: (`data`, `addr`) => `void`

#### Parameters

##### data

`Buffer`

##### addr

readonly \[`string`, `number`\]

#### Returns

`void`

#### Implementation of

[`Transport`](../interfaces/Transport.md).[`onData`](../interfaces/Transport.md#ondata)

***

### rinfo?

> `optional` **rinfo**: `Partial`\<`Pick`\<`RemoteInfo`, `"port"` \| `"address"`\>\>

***

### socket

> `readonly` **socket**: `Socket`

***

### type

> `readonly` **type**: `"udp"` = `"udp"`

#### Implementation of

[`Transport`](../interfaces/Transport.md).[`type`](../interfaces/Transport.md#type)

## Accessors

### address

#### Get Signature

> **get** **address**(): `AddressInfo`

##### Returns

`AddressInfo`

#### Implementation of

[`Transport`](../interfaces/Transport.md).[`address`](../interfaces/Transport.md#address)

***

### host

#### Get Signature

> **get** **host**(): `string`

##### Returns

`string`

***

### port

#### Get Signature

> **get** **port**(): `number`

##### Returns

`number`

## Methods

### close()

> **close**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`Transport`](../interfaces/Transport.md).[`close`](../interfaces/Transport.md#close)

***

### send()

> **send**(`data`, `addr`?): `Promise`\<`void`\>

#### Parameters

##### data

`Buffer`

##### addr?

readonly \[`string`, `number`\]

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`Transport`](../interfaces/Transport.md).[`send`](../interfaces/Transport.md#send)

***

### sendAndWait()

> **sendAndWait**(`data`, `addr`?): `Promise`\<`void`\>

Optional flush: wait until the datagram is accepted by the kernel.
Hot-path [send](../interfaces/Transport.md#send) must stay fire-and-forget for resolved IP peers.
DTLS close_notify uses this so a following socket.close() cannot drop it.

#### Parameters

##### data

`Buffer`

##### addr?

readonly \[`string`, `number`\]

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`Transport`](../interfaces/Transport.md).[`sendAndWait`](../interfaces/Transport.md#sendandwait)

***

### init()

> `static` **init**(`type`, `options`): `Promise`\<[`UdpTransport`](UdpTransport.md)\>

#### Parameters

##### type

`SocketType`

##### options

###### interfaceAddresses?

[`InterfaceAddresses`](../type-aliases/InterfaceAddresses.md)

###### port?

`number`

###### portRange?

\[`number`, `number`\]

#### Returns

`Promise`\<[`UdpTransport`](UdpTransport.md)\>

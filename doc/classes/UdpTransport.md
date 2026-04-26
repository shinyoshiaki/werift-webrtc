[**werift**](../README.md) • **Docs**

***

[werift](../globals.md) / UdpTransport

# Class: UdpTransport

## Implements

- [`Transport`](../interfaces/Transport.md)

## Properties

### onData()

> **onData**: (`data`, `addr`) => `void`

#### Parameters

• **data**: `Buffer`

• **addr**: readonly [`string`, `number`]

#### Returns

`void`

#### Implementation of

[`Transport`](../interfaces/Transport.md).[`onData`](../interfaces/Transport.md#ondata)

***

### socket

> `readonly` **socket**: `Socket`

***

### type

> `readonly` **type**: `"udp"` = `"udp"`

#### Implementation of

[`Transport`](../interfaces/Transport.md).[`type`](../interfaces/Transport.md#type)

## Methods

### address()

> **address**(): `AddressInfo`

#### Returns

`AddressInfo`

***

### close()

> **close**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`Transport`](../interfaces/Transport.md).[`close`](../interfaces/Transport.md#close)

***

### send()

> **send**(`data`, `addr`): `Promise`\<`void`\>

#### Parameters

• **data**: `Buffer`

• **addr**: readonly [`string`, `number`]

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`Transport`](../interfaces/Transport.md).[`send`](../interfaces/Transport.md#send)

***

### init()

> `static` **init**(`type`, `portRange`?, `interfaceAddresses`?): `Promise`\<[`UdpTransport`](UdpTransport.md)\>

#### Parameters

• **type**: `SocketType`

• **portRange?**: [`number`, `number`]

• **interfaceAddresses?**: [`InterfaceAddresses`](../type-aliases/InterfaceAddresses.md)

#### Returns

`Promise`\<[`UdpTransport`](UdpTransport.md)\>

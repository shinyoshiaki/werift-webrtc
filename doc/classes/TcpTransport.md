[**werift**](../README.md)

***

[werift](../globals.md) / TcpTransport

# Class: TcpTransport

## Implements

- [`Transport`](../interfaces/Transport.md)

## Properties

### type

> `readonly` **type**: `"tcp"`

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

### closed

#### Get Signature

> **get** **closed**(): `boolean`

##### Returns

`boolean`

#### Implementation of

[`Transport`](../interfaces/Transport.md).[`closed`](../interfaces/Transport.md#closed)

***

### onData

#### Get Signature

> **get** **onData**(): (`data`, `addr`) => `void`

##### Returns

`Function`

###### Parameters

###### data

`Buffer`

###### addr

readonly \[`string`, `number`\]

###### Returns

`void`

#### Set Signature

> **set** **onData**(`handler`): `void`

##### Parameters

###### handler

(`data`, `addr`) => `void`

##### Returns

`void`

#### Implementation of

[`Transport`](../interfaces/Transport.md).[`onData`](../interfaces/Transport.md#ondata)

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

### init()

> `static` **init**(`addr`): `Promise`\<[`TcpTransport`](TcpTransport.md)\>

#### Parameters

##### addr

readonly \[`string`, `number`\]

#### Returns

`Promise`\<[`TcpTransport`](TcpTransport.md)\>

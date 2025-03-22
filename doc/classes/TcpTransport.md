[**werift**](../README.md) • **Docs**

***

[werift](../globals.md) / TcpTransport

# Class: TcpTransport

## Implements

- [`Transport`](../interfaces/Transport.md)

## Properties

### closed

> **closed**: `boolean` = `false`

***

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

### type

> `readonly` **type**: `"tcp"` = `"tcp"`

#### Implementation of

[`Transport`](../interfaces/Transport.md).[`type`](../interfaces/Transport.md#type)

## Methods

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

> `static` **init**(`addr`): `Promise`\<[`TcpTransport`](TcpTransport.md)\>

#### Parameters

• **addr**: readonly [`string`, `number`]

#### Returns

`Promise`\<[`TcpTransport`](TcpTransport.md)\>

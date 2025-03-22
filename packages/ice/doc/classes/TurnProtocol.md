[**werift-ice**](../README.md) • **Docs**

***

[werift-ice](../globals.md) / TurnProtocol

# Class: TurnProtocol

## Implements

- [`Protocol`](../interfaces/Protocol.md)

## Constructors

### new TurnProtocol()

> **new TurnProtocol**(`server`, `username`, `password`, `lifetime`, `transport`, `options`): [`TurnProtocol`](TurnProtocol.md)

#### Parameters

• **server**: readonly [`string`, `number`]

• **username**: `string`

• **password**: `string`

• **lifetime**: `number`

• **transport**: [`Transport`](../interfaces/Transport.md)

• **options** = `{}`

• **options.channelRefreshTime?**: `number`

sec

#### Returns

[`TurnProtocol`](TurnProtocol.md)

## Properties

### integrityKey?

> `optional` **integrityKey**: `Buffer`

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

> **mappedAddress**: readonly [`string`, `number`]

***

### nonce?

> `optional` **nonce**: `Buffer`

***

### onData

> `readonly` **onData**: `Event`\<[`Buffer`, readonly [`string`, `number`]]\>

***

### onDataReceived

> **onDataReceived**: `Event`\<[`Buffer`]\>

#### Implementation of

[`Protocol`](../interfaces/Protocol.md).[`onDataReceived`](../interfaces/Protocol.md#ondatareceived)

***

### onRequestReceived

> **onRequestReceived**: `Event`\<[[`Message`](Message.md), readonly [`string`, `number`], `Buffer`]\>

#### Implementation of

[`Protocol`](../interfaces/Protocol.md).[`onRequestReceived`](../interfaces/Protocol.md#onrequestreceived)

***

### options

> **options**: `object` = `{}`

#### channelRefreshTime?

> `optional` **channelRefreshTime**: `number`

sec

***

### password

> **password**: `string`

***

### realm?

> `optional` **realm**: `string`

***

### relayedAddress

> **relayedAddress**: readonly [`string`, `number`]

***

### server

> **server**: readonly [`string`, `number`]

***

### transactions

> **transactions**: `object` = `{}`

#### Index Signature

 \[`hexId`: `string`\]: `Transaction`

***

### transport

> **transport**: [`Transport`](../interfaces/Transport.md)

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

> **getChannel**(`addr`): `Promise`\<`object`\>

#### Parameters

• **addr**: readonly [`string`, `number`]

#### Returns

`Promise`\<`object`\>

##### address

> **address**: readonly [`string`, `number`]

##### number

> **number**: `number`

***

### getPermission()

> **getPermission**(`addr`): `Promise`\<`void`\>

#### Parameters

• **addr**: readonly [`string`, `number`]

#### Returns

`Promise`\<`void`\>

***

### request()

> **request**(`request`, `addr`): `Promise`\<[[`Message`](Message.md), readonly [`string`, `number`]]\>

#### Parameters

• **request**: [`Message`](Message.md)

• **addr**: readonly [`string`, `number`]

#### Returns

`Promise`\<[[`Message`](Message.md), readonly [`string`, `number`]]\>

#### Implementation of

[`Protocol`](../interfaces/Protocol.md).[`request`](../interfaces/Protocol.md#request)

***

### requestWithRetry()

> **requestWithRetry**(`request`, `addr`): `Promise`\<[[`Message`](Message.md), readonly [`string`, `number`]]\>

#### Parameters

• **request**: [`Message`](Message.md)

• **addr**: readonly [`string`, `number`]

#### Returns

`Promise`\<[[`Message`](Message.md), readonly [`string`, `number`]]\>

***

### sendData()

> **sendData**(`data`, `addr`): `Promise`\<`void`\>

#### Parameters

• **data**: `Buffer`

• **addr**: readonly [`string`, `number`]

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`Protocol`](../interfaces/Protocol.md).[`sendData`](../interfaces/Protocol.md#senddata)

***

### sendStun()

> **sendStun**(`message`, `addr`): `Promise`\<`void`\>

#### Parameters

• **message**: [`Message`](Message.md)

• **addr**: readonly [`string`, `number`]

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`Protocol`](../interfaces/Protocol.md).[`sendStun`](../interfaces/Protocol.md#sendstun)

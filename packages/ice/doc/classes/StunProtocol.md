[**werift-ice**](../README.md) • **Docs**

***

[werift-ice](../globals.md) / StunProtocol

# Class: StunProtocol

## Implements

- [`Protocol`](../interfaces/Protocol.md)

## Constructors

### new StunProtocol()

> **new StunProtocol**(): [`StunProtocol`](StunProtocol.md)

#### Returns

[`StunProtocol`](StunProtocol.md)

## Properties

### localCandidate?

> `optional` **localCandidate**: [`Candidate`](Candidate.md)

#### Implementation of

[`Protocol`](../interfaces/Protocol.md).[`localCandidate`](../interfaces/Protocol.md#localcandidate)

***

### localIp?

> `optional` **localIp**: `string`

#### Implementation of

[`Protocol`](../interfaces/Protocol.md).[`localIp`](../interfaces/Protocol.md#localip)

***

### onDataReceived

> `readonly` **onDataReceived**: `Event`\<[`Buffer`]\>

#### Implementation of

[`Protocol`](../interfaces/Protocol.md).[`onDataReceived`](../interfaces/Protocol.md#ondatareceived)

***

### onRequestReceived

> `readonly` **onRequestReceived**: `Event`\<[[`Message`](Message.md), readonly [`string`, `number`], `Buffer`]\>

#### Implementation of

[`Protocol`](../interfaces/Protocol.md).[`onRequestReceived`](../interfaces/Protocol.md#onrequestreceived)

***

### sentMessage?

> `optional` **sentMessage**: [`Message`](Message.md)

#### Implementation of

[`Protocol`](../interfaces/Protocol.md).[`sentMessage`](../interfaces/Protocol.md#sentmessage)

***

### transactions

> **transactions**: `object` = `{}`

#### Index Signature

 \[`key`: `string`\]: `Transaction`

***

### transport

> **transport**: [`UdpTransport`](UdpTransport.md)

***

### type

> `readonly` **type**: `"stun"` = `StunProtocol.type`

#### Implementation of

[`Protocol`](../interfaces/Protocol.md).[`type`](../interfaces/Protocol.md#type)

***

### type

> `readonly` `static` **type**: `"stun"` = `"stun"`

## Accessors

### transactionsKeys

> `get` **transactionsKeys**(): `string`[]

#### Returns

`string`[]

## Methods

### close()

> **close**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`Protocol`](../interfaces/Protocol.md).[`close`](../interfaces/Protocol.md#close)

***

### connectionMade()

> **connectionMade**(`useIpv4`, `portRange`?, `interfaceAddresses`?): `Promise`\<`void`\>

#### Parameters

• **useIpv4**: `boolean`

• **portRange?**: [`number`, `number`]

• **interfaceAddresses?**: `InterfaceAddresses`

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`Protocol`](../interfaces/Protocol.md).[`connectionMade`](../interfaces/Protocol.md#connectionmade)

***

### getExtraInfo()

> **getExtraInfo**(): readonly [`string`, `number`]

#### Returns

readonly [`string`, `number`]

***

### request()

> **request**(`request`, `addr`, `integrityKey`?, `retransmissions`?): `Promise`\<[[`Message`](Message.md), readonly [`string`, `number`]]\>

#### Parameters

• **request**: [`Message`](Message.md)

• **addr**: readonly [`string`, `number`]

• **integrityKey?**: `Buffer`

• **retransmissions?**: `number`

#### Returns

`Promise`\<[[`Message`](Message.md), readonly [`string`, `number`]]\>

#### Implementation of

[`Protocol`](../interfaces/Protocol.md).[`request`](../interfaces/Protocol.md#request)

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

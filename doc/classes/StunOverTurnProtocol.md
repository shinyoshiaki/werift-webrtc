[**werift**](../README.md) • **Docs**

***

[werift](../globals.md) / StunOverTurnProtocol

# Class: StunOverTurnProtocol

## Implements

- [`Protocol`](../interfaces/Protocol.md)

## Constructors

### new StunOverTurnProtocol()

> **new StunOverTurnProtocol**(`turn`): [`StunOverTurnProtocol`](StunOverTurnProtocol.md)

#### Parameters

• **turn**: [`TurnProtocol`](TurnProtocol.md)

#### Returns

[`StunOverTurnProtocol`](StunOverTurnProtocol.md)

## Properties

### localCandidate

> **localCandidate**: [`Candidate`](Candidate.md)

#### Implementation of

[`Protocol`](../interfaces/Protocol.md).[`localCandidate`](../interfaces/Protocol.md#localcandidate)

***

### onDataReceived

> **onDataReceived**: [`Event`](Event.md)\<[`Buffer`]\>

#### Implementation of

[`Protocol`](../interfaces/Protocol.md).[`onDataReceived`](../interfaces/Protocol.md#ondatareceived)

***

### onRequestReceived

> **onRequestReceived**: [`Event`](Event.md)\<[[`Message`](Message.md), readonly [`string`, `number`], `Buffer`]\>

#### Implementation of

[`Protocol`](../interfaces/Protocol.md).[`onRequestReceived`](../interfaces/Protocol.md#onrequestreceived)

***

### turn

> **turn**: [`TurnProtocol`](TurnProtocol.md)

***

### type

> `readonly` **type**: `string` = `StunOverTurnProtocol.type`

#### Implementation of

[`Protocol`](../interfaces/Protocol.md).[`type`](../interfaces/Protocol.md#type)

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

### request()

> **request**(`request`, `addr`, `integrityKey`?): `Promise`\<[[`Message`](Message.md), readonly [`string`, `number`]]\>

#### Parameters

• **request**: [`Message`](Message.md)

• **addr**: readonly [`string`, `number`]

• **integrityKey?**: `Buffer`

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

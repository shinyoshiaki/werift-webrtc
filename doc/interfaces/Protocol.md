[**werift**](../README.md) • **Docs**

***

[werift](../globals.md) / Protocol

# Interface: Protocol

## Properties

### close()

> **close**: () => `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

***

### connectionMade()

> **connectionMade**: (...`args`) => `Promise`\<`void`\>

#### Parameters

• ...**args**: `any`

#### Returns

`Promise`\<`void`\>

***

### localCandidate?

> `optional` **localCandidate**: [`Candidate`](../classes/Candidate.md)

***

### localIp?

> `optional` **localIp**: `string`

***

### onDataReceived

> **onDataReceived**: [`Event`](../classes/Event.md)\<[`Buffer`]\>

***

### onRequestReceived

> **onRequestReceived**: [`Event`](../classes/Event.md)\<[[`Message`](../classes/Message.md), readonly [`string`, `number`], `Buffer`]\>

***

### request()

> **request**: (`message`, `addr`, `integrityKey`?, `retransmissions`?) => `Promise`\<[[`Message`](../classes/Message.md), readonly [`string`, `number`]]\>

#### Parameters

• **message**: [`Message`](../classes/Message.md)

• **addr**: readonly [`string`, `number`]

• **integrityKey?**: `Buffer`

• **retransmissions?**: `any`

#### Returns

`Promise`\<[[`Message`](../classes/Message.md), readonly [`string`, `number`]]\>

***

### responseAddr?

> `optional` **responseAddr**: readonly [`string`, `number`]

***

### responseMessage?

> `optional` **responseMessage**: `string`

***

### sendData()

> **sendData**: (`data`, `addr`) => `Promise`\<`void`\>

#### Parameters

• **data**: `Buffer`

• **addr**: readonly [`string`, `number`]

#### Returns

`Promise`\<`void`\>

***

### sendStun()

> **sendStun**: (`message`, `addr`) => `Promise`\<`void`\>

#### Parameters

• **message**: [`Message`](../classes/Message.md)

• **addr**: readonly [`string`, `number`]

#### Returns

`Promise`\<`void`\>

***

### sentMessage?

> `optional` **sentMessage**: [`Message`](../classes/Message.md)

***

### type

> **type**: `string`

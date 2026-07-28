[**werift-ice**](../README.md)

***

[werift-ice](../globals.md) / Protocol

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

##### args

...`any`

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

> **onDataReceived**: `Event`\<\[`Buffer`\<`ArrayBufferLike`\>\]\>

***

### onRequestReceived

> **onRequestReceived**: `Event`\<\[[`Message`](../classes/Message.md), readonly \[`string`, `number`\], `Buffer`\<`ArrayBufferLike`\>\]\>

***

### request()

> **request**: (`message`, `addr`, `integrityKey`?, `retransmissionsOrOptions`?, `onRequestSent`?) => `Promise`\<\[[`Message`](../classes/Message.md), readonly \[`string`, `number`\]\]\>

The 4th argument accepts either a legacy retransmission count (`number`) or a
`TransactionRequestOptions` object (`retransmissions`, `responseTimeout`,
`onRequestSent`, `signal`). Consent freshness uses `{ retransmissions: 0,
responseTimeout: CONSENT_RESPONSE_TIMEOUT }` so a single send can wait longer
than the default STUN RTO without retransmitting.

#### Parameters

##### message

[`Message`](../classes/Message.md)

##### addr

readonly \[`string`, `number`\]

##### integrityKey?

`Buffer`\<`ArrayBufferLike`\>

##### retransmissionsOrOptions?

`number` \| `TransactionRequestOptions`

##### onRequestSent?

(`attempt`) => `void`

#### Returns

`Promise`\<\[[`Message`](../classes/Message.md), readonly \[`string`, `number`\]\]\>

***

### responseAddr?

> `optional` **responseAddr**: readonly \[`string`, `number`\]

***

### responseMessage?

> `optional` **responseMessage**: `string`

***

### sendData()

> **sendData**: (`data`, `addr`) => `Promise`\<`void`\>

#### Parameters

##### data

`Buffer`

##### addr

readonly \[`string`, `number`\]

#### Returns

`Promise`\<`void`\>

***

### sendStun()

> **sendStun**: (`message`, `addr`) => `Promise`\<`void`\>

#### Parameters

##### message

[`Message`](../classes/Message.md)

##### addr

readonly \[`string`, `number`\]

#### Returns

`Promise`\<`void`\>

***

### sentMessage?

> `optional` **sentMessage**: [`Message`](../classes/Message.md)

***

### type

> **type**: `string`

[**werift**](../README.md)

***

[werift](../globals.md) / Protocol

# Interface: Protocol

## Properties

### close

> **close**: () => `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

***

### connectionMade

> **connectionMade**: (...`args`) => `Promise`\<`void`\>

#### Parameters

##### args

...`any`

#### Returns

`Promise`\<`void`\>

***

### localCandidate?

> `optional` **localCandidate?**: [`Candidate`](../classes/Candidate.md)

***

### localIp?

> `optional` **localIp?**: `string`

***

### onConnectionClosed?

> `optional` **onConnectionClosed?**: [`Event`](../classes/Event.md)\<\[readonly \[`string`, `number`\]\]\>

Connection-oriented protocols: the connection to this remote address is gone.

***

### onDataReceived

> **onDataReceived**: [`Event`](../classes/Event.md)\<\[`Buffer`\<`ArrayBufferLike`\>, readonly \[`string`, `number`\]\]\>

Application data (not STUN) and the remote address it came from.

***

### onPathBroken?

> `optional` **onPathBroken?**: [`Event`](../classes/Event.md)\<\[readonly \[`string`, `number`\] \| `undefined`, `Error`\]\>

Sending failed in a way that says the path is gone, not just a lost
packet: a routing error from the OS for this remote address (see
`PATH_BROKEN_SEND_ERRORS`), or, with no address, every path of the
protocol (its TURN allocation is lost: the connection to the TURN
server closed, a Refresh failed, the server is unreachable). The ICE
agent fails over at once instead of waiting for unanswered checks.

***

### onRequestReceived

> **onRequestReceived**: [`Event`](../classes/Event.md)\<\[[`Message`](../classes/Message.md), readonly \[`string`, `number`\], `Buffer`\<`ArrayBufferLike`\>\]\>

***

### request

> **request**: (`message`, `addr`, `integrityKey?`, `retransmissionsOrOptions?`, `onRequestSent?`) => `Promise`\<\[[`Message`](../classes/Message.md), readonly \[`string`, `number`\]\]\>

#### Parameters

##### message

[`Message`](../classes/Message.md)

##### addr

readonly \[`string`, `number`\]

##### integrityKey?

`Buffer`\<`ArrayBufferLike`\>

##### retransmissionsOrOptions?

`number` \| [`TransactionRequestOptions`](TransactionRequestOptions.md)

##### onRequestSent?

(`attempt`) => `void`

#### Returns

`Promise`\<\[[`Message`](../classes/Message.md), readonly \[`string`, `number`\]\]\>

***

### responseAddr?

> `optional` **responseAddr?**: readonly \[`string`, `number`\]

***

### responseMessage?

> `optional` **responseMessage?**: `string`

***

### sendData

> **sendData**: (`data`, `addr`) => `Promise`\<`void`\>

#### Parameters

##### data

`Buffer`

##### addr

readonly \[`string`, `number`\]

#### Returns

`Promise`\<`void`\>

***

### sendStun

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

> `optional` **sentMessage?**: [`Message`](../classes/Message.md)

***

### type

> **type**: `string`

[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / Transport

# Interface: Transport

## Properties

### address

> **address**: `AddressInfo`

***

### addressFamily?

> `optional` **addressFamily?**: [`IpAddressFamily`](../type-aliases/IpAddressFamily.md)

IP family of a datagram socket. A datagram transport can only reach
addresses of this family. Built-in UDP transports always set it; a custom
transport that leaves it unset gets no family preference.

***

### close

> **close**: () => `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

***

### closed

> **closed**: `boolean`

***

### onData

> **onData**: (`data`, `addr`) => `void`

#### Parameters

##### data

`Buffer`

##### addr

readonly \[`string`, `number`\]

#### Returns

`void`

***

### onError?

> `optional` **onError**: [`Event`](../classes/Event.md)\<\[`Error`\]\>

Runtime transport errors that do not close the transport. Optional so
custom transports need not implement it; the built-in UDP transport does.

***

### remoteAddress?

> `optional` **remoteAddress?**: readonly \[`string`, `number`\]

The peer a connected (stream) transport is talking to. Responses arrive
from this address. Built-in TCP/TLS transports set it once connected.

***

### send

> **send**: (`data`, `addr?`) => `Promise`\<`void`\>

#### Parameters

##### data

`Buffer`

##### addr?

readonly \[`string`, `number`\]

#### Returns

`Promise`\<`void`\>

***

### type

> **type**: `string`

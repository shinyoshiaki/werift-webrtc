[**werift**](../README.md)

***

[werift](../globals.md) / Transport

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

### onClosed?

> `optional` **onClosed?**: [`Event`](../classes/Event.md)\<\[\]\>

The transport closed by itself after it was established (a stream whose
peer closed the connection, or that an error destroyed); not emitted by
`close()`. Optional: datagram transports do not close by themselves.

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

> `optional` **onError?**: [`Event`](../classes/Event.md)\<\[`Error`\]\>

Runtime transport errors that do not close the transport. Optional so
custom transports need not implement it; the built-in UDP transport does.

***

### peerAuthenticated?

> `optional` **peerAuthenticated?**: `boolean`

When true, the transport path is already peer-authenticated (e.g. ICE).
DTLS 1.2 may treat protected records as association-authenticated even
without a UDP 5-tuple pin (ICE does not expose source address on RX).

***

### remoteAddress?

> `optional` **remoteAddress?**: readonly \[`string`, `number`\]

The peer a connected (stream) transport is talking to. Responses arrive
from this address. Built-in TCP/TLS transports set it once connected.

***

### send

> **send**: (`data`, `addr?`, `options?`) => `Promise`\<`void`\>

#### Parameters

##### data

`Buffer`

##### addr?

readonly \[`string`, `number`\]

##### options?

[`TransportSendOptions`](TransportSendOptions.md)

#### Returns

`Promise`\<`void`\>

***

### type

> **type**: `string`

[**werift**](../README.md)

***

[werift](../globals.md) / Transport

# Interface: Transport

## Properties

### address

> **address**: `AddressInfo`

***

### addressFamily?

> `optional` **addressFamily**: [`IpAddressFamily`](../type-aliases/IpAddressFamily.md)

IP family of a datagram socket. A datagram transport can only reach
addresses of this family. Built-in UDP transports always set it; a custom
transport that leaves it unset gets no family preference.

***

### close()

> **close**: () => `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

***

### closed

> **closed**: `boolean`

***

### onData()

> **onData**: (`data`, `addr`, `meta`?) => `void`

#### Parameters

##### data

`Buffer`

##### addr

readonly \[`string`, `number`\]

##### meta?

[`DatagramRxMeta`](DatagramRxMeta.md)

#### Returns

`void`

***

### peerAuthenticated?

> `optional` **peerAuthenticated**: `boolean`

When true, the transport path is already peer-authenticated (e.g. ICE).
DTLS 1.2 may treat protected records as association-authenticated even
without a UDP 5-tuple pin (ICE does not expose source address on RX).

***

### remoteAddress?

> `optional` **remoteAddress**: readonly \[`string`, `number`\]

The peer a connected (stream) transport is talking to. Responses arrive
from this address. Built-in TCP/TLS transports set it once connected.

***

### send()

> **send**: (`data`, `addr`?) => `Promise`\<`void`\>

#### Parameters

##### data

`Buffer`

##### addr?

readonly \[`string`, `number`\]

#### Returns

`Promise`\<`void`\>

***

### sendAndWait()?

> `optional` **sendAndWait**: (`data`, `addr`?) => `Promise`\<`void`\>

Optional flush: wait until the datagram is accepted by the kernel.
Hot-path [send](Transport.md#send) must stay fire-and-forget for resolved IP peers.
DTLS close_notify uses this so a following socket.close() cannot drop it.

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

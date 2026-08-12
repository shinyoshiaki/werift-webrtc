[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / Transport

# Interface: Transport

## Properties

### address

> **address**: `AddressInfo`

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

> **onData**: (`data`, `addr`) => `void`

#### Parameters

##### data

`Buffer`

##### addr

readonly \[`string`, `number`\]

#### Returns

`void`

***

### peerAuthenticated?

> `optional` **peerAuthenticated**: `boolean`

When true, the transport path is already peer-authenticated (e.g. ICE).
DTLS 1.2 may treat protected records as association-authenticated even
without a UDP 5-tuple pin (ICE does not expose source address on RX).

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

### type

> **type**: `string`

[**werift**](../README.md)

***

[werift](../globals.md) / IceOptions

# Interface: IceOptions

## Properties

### additionalHostAddresses?

> `optional` **additionalHostAddresses**: `string`[]

***

### filterCandidatePair()?

> `optional` **filterCandidatePair**: (`pair`) => `boolean`

#### Parameters

##### pair

[`CandidatePair`](../classes/CandidatePair.md)

#### Returns

`boolean`

***

### filterStunResponse()?

> `optional` **filterStunResponse**: (`message`, `addr`, `protocol`) => `boolean`

#### Parameters

##### message

[`Message`](../classes/Message.md)

##### addr

readonly \[`string`, `number`\]

##### protocol

[`Protocol`](Protocol.md)

#### Returns

`boolean`

***

### forceTurn?

> `optional` **forceTurn**: `boolean`

***

### iceLite

> **iceLite**: `boolean`

Advertise and operate as an ICE lite agent.

***

### interfaceAddresses?

> `optional` **interfaceAddresses**: [`InterfaceAddresses`](../type-aliases/InterfaceAddresses.md)

***

### localPasswordPrefix?

> `optional` **localPasswordPrefix**: `string`

***

### portRange?

> `optional` **portRange**: \[`number`, `number`\]

***

### stunGatherTimeout?

> `optional` **stunGatherTimeout**: `number`

Seconds to wait for server-reflexive candidates while gathering.
Defaults to 5. Where UDP is blocked these STUN queries are never answered,
so the wait always runs to the timeout; agents that must not stall on such
networks can lower it.

***

### stunServer?

> `optional` **stunServer**: readonly \[`string`, `number`\]

***

### tcpPassive?

> `optional` **tcpPassive**: `boolean`

Gather passive TCP host candidates (opens a listening TCP server per
interface). Defaults to true. Send-only agents that never accept inbound
connections can set this false to avoid the listener while still gathering
active TCP candidates.

***

### turnPassword?

> `optional` **turnPassword**: `string`

***

### turnServer?

> `optional` **turnServer**: readonly \[`string`, `number`\]

***

### turnTlsOptions?

> `optional` **turnTlsOptions**: [`TlsConnectionOptions`](../type-aliases/TlsConnectionOptions.md)

***

### turnTransport?

> `optional` **turnTransport**: `"tcp"` \| `"tls"` \| `"udp"`

***

### turnUsername?

> `optional` **turnUsername**: `string`

***

### useIpv4

> **useIpv4**: `boolean`

***

### useIpv6

> **useIpv6**: `boolean`

***

### useLinkLocalAddress?

> `optional` **useLinkLocalAddress**: `boolean`

***

### useTcp

> **useTcp**: `boolean`

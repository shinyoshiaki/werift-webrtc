[**werift-ice**](../README.md)

***

[werift-ice](../globals.md) / IceOptions

# Interface: IceOptions

## Properties

### additionalHostAddresses?

> `optional` **additionalHostAddresses**: `string`[]

Host addresses gathered in addition to the enumerated ones. For a family
bound by `interfaceAddresses`, addresses other than the bound one are
ignored.

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

> `optional` **interfaceAddresses**: `InterfaceAddresses`

Local addresses to bind the UDP host sockets to, per family.

The address given for a family (`udp4` / `udp6`) is the only host
address of that family: its UDP host candidate advertises the address and
port the socket is actually bound to, even when the address is not among
the enumerated network interfaces (loopback, tun, ...), and its TCP host
candidates use it too. Other enumerated addresses of that family are not
gathered. If the bind fails, the family has no UDP host candidate.

A family left unspecified while the other one is set gathers no
enumerated addresses (only its `additionalHostAddresses`). Without any
family set, every enumerated address is gathered over wildcard sockets.

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

### turnConnectTimeout?

> `optional` **turnConnectTimeout**: `number`

Seconds to wait for a TURN TCP/TLS connection to be established.
Defaults to 8.

***

### turnPassword?

> `optional` **turnPassword**: `string`

***

### turnServer?

> `optional` **turnServer**: readonly \[`string`, `number`\]

***

### turnTlsOptions?

> `optional` **turnTlsOptions**: `TlsConnectionOptions`

***

### turnTransport?

> `optional` **turnTransport**: `"udp"` \| `"tcp"` \| `"tls"`

***

### turnUdpFamily?

> `optional` **turnUdpFamily**: `4` \| `6`

Preferred IP family of the TURN/UDP socket, applied only when turnServer
is a hostname. Ignored for an IP literal turnServer, whose own family
always selects the socket. Defaults to 4.

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

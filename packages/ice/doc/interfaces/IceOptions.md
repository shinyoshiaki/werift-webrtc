[**werift-ice**](../README.md)

***

[werift-ice](../globals.md) / IceOptions

# Interface: IceOptions

## Properties

### additionalHostAddresses?

> `optional` **additionalHostAddresses?**: `string`[]

Host addresses gathered in addition to the enumerated ones. For a family
bound by `interfaceAddresses`, addresses other than the bound one are
ignored.

***

### filterCandidatePair?

> `optional` **filterCandidatePair?**: (`pair`) => `boolean`

#### Parameters

##### pair

[`CandidatePair`](../classes/CandidatePair.md)

#### Returns

`boolean`

***

### filterStunResponse?

> `optional` **filterStunResponse?**: (`message`, `addr`, `protocol`) => `boolean`

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

> `optional` **forceTurn?**: `boolean`

***

### iceLite

> **iceLite**: `boolean`

Advertise and operate as an ICE lite agent.

***

### interfaceAddresses?

> `optional` **interfaceAddresses?**: `InterfaceAddresses`

Local addresses to bind the UDP host sockets to, per family.

The address given for a family (`udp4` / `udp6`) is the only host
address of that family: its UDP host candidate advertises the address and
port the socket is actually bound to, even when the address is not among
the enumerated network interfaces (loopback, tun, ...), and its TCP host
candidates use it too. Other enumerated addresses of that family are not
gathered. If the bind fails, the family has no UDP host candidate.

A family left unspecified while the other one is set gathers no
enumerated addresses (only its `additionalHostAddresses`).

Without any family set, every enumerated address gets its own UDP host
socket bound to that address (an IPv6 link-local one with its zone), so
the socket's packets leave from the advertised candidate address even on
a host with several network interfaces. An address whose bind fails, or
whose sends fail, loses only its own candidate; the other addresses are
unaffected. An `additionalHostAddresses` entry that is not assigned to a
local interface (a 1:1 NAT public address, for example) is gathered over
a wildcard socket. The enumerated addresses include costly networks (VPN
/ tunnel interfaces: `ipsec`, `tun`, `utun`, `tap`) with a low local
preference; `vmnet` / `veth` interfaces are excluded. The default-route
address gets the highest local preference, so checks start with the path
the OS uses: the source address of the route to the first configured
STUN / TURN server that resolves in the family and has a route (UDP
`connect()`, no packet is sent). A family without such a server has no
default-route address: no other address (no public one) is probed in
its place, and its host candidates keep the gathering order. With a STUN
server, a wildcard socket per family maps the route the
OS picks (see `stunServers`).

A family set to the wildcard address (`0.0.0.0` / `::`) gathers its
enumerated and additional addresses over wildcard sockets instead;
the wildcard address itself is never advertised.

***

### localPasswordPrefix?

> `optional` **localPasswordPrefix?**: `string`

***

### messageIntegrity?

> `optional` **messageIntegrity?**: [`MessageIntegrityMode`](../type-aliases/MessageIntegrityMode.md)

Integrity attributes of the connectivity checks and consent requests this
agent sends (short-term credentials, RFC 8489):
- `"sha1"` (default): MESSAGE-INTEGRITY only, what every browser accepts.
- `"sha256"`: MESSAGE-INTEGRITY-SHA256 only. A peer that does not know
  the comprehension-required 0x001C attribute rejects such checks (420
  or no answer), so use it only with a peer known to support it.
- `"both"`: MESSAGE-INTEGRITY followed by MESSAGE-INTEGRITY-SHA256.

Received requests and responses are accepted with either algorithm, and
a response is always signed with the algorithm of its request
(MESSAGE-INTEGRITY-SHA256 when the request carried it, RFC 8489 §9.1.3).

***

### portRange?

> `optional` **portRange?**: \[`number`, `number`\]

***

### stunGatherTimeout?

> `optional` **stunGatherTimeout?**: `number`

Seconds to wait for server-reflexive candidates while gathering.
Defaults to 5. Where UDP is blocked these STUN queries are never answered,
so the wait always runs to the timeout; agents that must not stall on such
networks can lower it.

`gatherCandidates()` waits only for the representative sockets' queries
(see `stunServers`); the other host sockets' queries continue up to this
timeout in the background and end-of-candidates follows them.

***

### ~~stunServer?~~

> `optional` **stunServer?**: readonly \[`string`, `number`\]

#### Deprecated

Use [IceOptions.stunServers](#stunservers). Kept as their first entry.

***

### stunServers?

> `optional` **stunServers?**: (readonly \[`string`, `number`\])[]

STUN servers queried while gathering, in priority order. Every IPv4 UDP
host socket queries each of them in parallel; equal mappings are
advertised once, different ones (a NAT that maps per destination) each.

Without `interfaceAddresses`, each family with a STUN server also gets a
UDP socket bound to the wildcard address that advertises no host
candidate: the OS picks its route (a full-tunnel VPN, an interface the
host sockets do not cover), and its server-reflexive candidates carry
the related address `0.0.0.0` / `::`. The IPv4 wildcard socket queries
every server, the IPv6 one only the IPv6 literal servers. It checks only
the remote candidates whose route leaves from an address no UDP host
socket is bound to, so a peer on a covered path learns no
peer-reflexive candidate from it.

`gatherCandidates()` returns once the representative sockets answered or
`stunGatherTimeout` ran out: the wildcard sockets and the host socket of
the default-route address (every host socket when a family has neither).
The other host sockets' server-reflexive candidates trickle through
`onIceCandidate`, and `localCandidatesEnd` follows the last of them
(`waitForLocalCandidatesEnd()`), so an interface that cannot reach the
STUN server does not delay the description.

Merged with the deprecated `stunServer`: the singular one comes first,
duplicates are dropped (see [normalizeIceServerOptions](../functions/normalizeIceServerOptions.md)).

***

### tcpPassive?

> `optional` **tcpPassive?**: `boolean`

Gather passive TCP host candidates (opens a listening TCP server per
interface). Defaults to true. Send-only agents that never accept inbound
connections can set this false to avoid the listener while still gathering
active TCP candidates.

***

### turnConnectTimeout?

> `optional` **turnConnectTimeout?**: `number`

Seconds to wait for a TURN TCP/TLS connection to be established.
Defaults to 8.

***

### ~~turnPassword?~~

> `optional` **turnPassword?**: `string`

#### Deprecated

Use [TurnServerOptions.password](../type-aliases/TurnServerOptions.md#password) of [IceOptions.turnServers](#turnservers).

***

### ~~turnServer?~~

> `optional` **turnServer?**: readonly \[`string`, `number`\]

#### Deprecated

Use [IceOptions.turnServers](#turnservers). Kept as their first entry.

***

### turnServers?

> `optional` **turnServers?**: [`TurnServerOptions`](../type-aliases/TurnServerOptions.md)[]

TURN servers allocated on while gathering, in priority order. Each one
gets its own allocation with its own credential and transport; one that
fails or times out does not stop the others. Gathering ends when the
slowest allocation completes or fails (`turnConnectTimeout` bounds a
TCP/TLS connection, the STUN transaction timeout an unanswered request).
`turnTlsOptions`, `turnUdpFamily`, `turnConnectTimeout`, `portRange` and
`interfaceAddresses` apply to every TURN server.

Merged with the deprecated `turnServer` / `turnUsername` /
`turnPassword` / `turnTransport`: the singular one comes first,
duplicates are dropped and an entry without username / password is
ignored (see [normalizeIceServerOptions](../functions/normalizeIceServerOptions.md)).

***

### turnTlsOptions?

> `optional` **turnTlsOptions?**: `TlsConnectionOptions`

Applied to every TLS TURN server.

***

### ~~turnTransport?~~

> `optional` **turnTransport?**: `"udp"` \| `"tcp"` \| `"tls"`

#### Deprecated

Use [TurnServerOptions.transport](../type-aliases/TurnServerOptions.md#transport) of [IceOptions.turnServers](#turnservers).

***

### turnUdpFamily?

> `optional` **turnUdpFamily?**: `4` \| `6`

Preferred IP family of a TURN/UDP socket, applied (to every TURN server)
only when the server is a hostname. Ignored for an IP literal server,
whose own family always selects the socket. Defaults to 4.

***

### ~~turnUsername?~~

> `optional` **turnUsername?**: `string`

#### Deprecated

Use [TurnServerOptions.username](../type-aliases/TurnServerOptions.md#username) of [IceOptions.turnServers](#turnservers).

***

### useDefaultStunServer?

> `optional` **useDefaultStunServer?**: `boolean`

Whether the built-in public STUN server (stun.l.google.com:19302) is used
when no STUN server is given. Defaults to true; false gathers no
server-reflexive candidate unless a STUN server is set.

***

### useIpv4

> **useIpv4**: `boolean`

***

### useIpv6

> **useIpv6**: `boolean`

***

### useLinkLocalAddress?

> `optional` **useLinkLocalAddress?**: `boolean`

***

### useTcp

> **useTcp**: `boolean`

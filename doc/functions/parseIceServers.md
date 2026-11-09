[**werift**](../README.md)

***

[werift](../globals.md) / parseIceServers

# Function: parseIceServers()

> **parseIceServers**(`iceServers`): `object`

The STUN and TURN servers of `iceServers`: every valid `stun:` / `stuns:`
URL and every valid `turn:` / `turns:` URL of every `RTCIceServer`, in
configuration order. A TURN URL carries the `username` / `credential` of
the `RTCIceServer` that lists it. Duplicates (the same STUN address; the
same TURN address, transport and credential) are kept once.

The singular fields are the first STUN URL and the first TURN URL, kept
for compatibility.

## Parameters

### iceServers

[`RTCIceServer`](../type-aliases/RTCIceServer.md)[]

## Returns

### ~~stunServer?~~

> `optional` **stunServer?**: readonly \[`string`, `number`\]

#### Deprecated

The first of `stunServers`.

### stunServers

> **stunServers**: (readonly \[`string`, `number`\])[]

### ~~turnPassword?~~

> `optional` **turnPassword?**: `string`

#### Deprecated

The password of the first of `turnServers`.

### ~~turnServer?~~

> `optional` **turnServer?**: readonly \[`string`, `number`\]

#### Deprecated

The address of the first of `turnServers`.

### turnServers

> **turnServers**: [`ParsedTurnServer`](../type-aliases/ParsedTurnServer.md)[]

### ~~turnTransport?~~

> `optional` **turnTransport?**: `"tcp"` \| `"tls"` \| `"udp"`

#### Deprecated

The transport of the first of `turnServers`.

### ~~turnUsername?~~

> `optional` **turnUsername?**: `string`

#### Deprecated

The username of the first of `turnServers`.

[**werift-ice**](../README.md)

***

[werift-ice](../globals.md) / serverReflexiveCandidate

# Function: serverReflexiveCandidate()

> **serverReflexiveCandidate**(`protocol`, `stunServer`, `base?`): `Promise`\<[`Candidate`](../classes/Candidate.md) \| `undefined`\>

Query a STUN server to obtain a server-reflexive candidate of `protocol`.
Its base is the protocol's host candidate, or `base` for a socket that
advertises no host candidate (the wildcard socket: related address
`0.0.0.0` / `::`).

## Parameters

### protocol

[`Protocol`](../interfaces/Protocol.md)

### stunServer

readonly \[`string`, `number`\]

### base?

`Pick`\<[`Candidate`](../classes/Candidate.md), `"component"` \| `"transport"` \| `"host"` \| `"port"`\> & `Partial`\<`Pick`\<[`Candidate`](../classes/Candidate.md), `"tcptype"`\>\>

## Returns

`Promise`\<[`Candidate`](../classes/Candidate.md) \| `undefined`\>

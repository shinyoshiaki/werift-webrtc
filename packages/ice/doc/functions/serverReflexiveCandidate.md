[**werift-ice**](../README.md)

***

[werift-ice](../globals.md) / serverReflexiveCandidate

# Function: serverReflexiveCandidate()

> **serverReflexiveCandidate**(`protocol`, `stunServer`, `base?`): `Promise`\<[`Candidate`](../classes/Candidate.md) \| `undefined`\>

Query a STUN server for a server-reflexive candidate. This compatibility
helper resolves `undefined` on failure; use
[queryServerReflexiveCandidate](queryServerReflexiveCandidate.md) when the failure reason is needed.

## Parameters

### protocol

[`Protocol`](../interfaces/Protocol.md)

### stunServer

readonly \[`string`, `number`\]

### base?

`Pick`\<[`Candidate`](../classes/Candidate.md), `"component"` \| `"transport"` \| `"host"` \| `"port"`\> & `Partial`\<`Pick`\<[`Candidate`](../classes/Candidate.md), `"tcptype"`\>\>

## Returns

`Promise`\<[`Candidate`](../classes/Candidate.md) \| `undefined`\>

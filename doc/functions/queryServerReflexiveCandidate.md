[**werift**](../README.md)

***

[werift](../globals.md) / queryServerReflexiveCandidate

# Function: queryServerReflexiveCandidate()

> **queryServerReflexiveCandidate**(`protocol`, `stunServer`, `base?`): `Promise`\<[`Candidate`](../classes/Candidate.md)\>

Query `stunServer` from `protocol` for a server-reflexive candidate.
Unlike [serverReflexiveCandidate](serverReflexiveCandidate.md) it rejects with the reason of a
failure. `base` is used for wildcard sockets that advertise no host
candidate themselves.

## Parameters

### protocol

[`Protocol`](../interfaces/Protocol.md)

### stunServer

readonly \[`string`, `number`\]

### base?

`Pick`\<[`Candidate`](../classes/Candidate.md), `"port"` \| `"host"` \| `"component"` \| `"transport"`\> & `Partial`\<`Pick`\<[`Candidate`](../classes/Candidate.md), `"tcptype"`\>\>

## Returns

`Promise`\<[`Candidate`](../classes/Candidate.md)\>

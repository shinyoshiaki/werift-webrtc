[**werift-ice**](../README.md)

***

[werift-ice](../globals.md) / serverReflexiveCandidate

# Function: serverReflexiveCandidate()

> **serverReflexiveCandidate**(`protocol`, `stunServer`): `Promise`\<[`Candidate`](../classes/Candidate.md) \| `undefined`\>

Query `stunServer` from `protocol` for a server-reflexive candidate;
undefined when the query fails (it never rejects). Use
[queryServerReflexiveCandidate](queryServerReflexiveCandidate.md) when the reason of a failure is
needed.

## Parameters

### protocol

[`Protocol`](../interfaces/Protocol.md)

### stunServer

readonly \[`string`, `number`\]

## Returns

`Promise`\<[`Candidate`](../classes/Candidate.md) \| `undefined`\>

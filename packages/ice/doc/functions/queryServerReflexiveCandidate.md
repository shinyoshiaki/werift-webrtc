[**werift-ice**](../README.md)

***

[werift-ice](../globals.md) / queryServerReflexiveCandidate

# Function: queryServerReflexiveCandidate()

> **queryServerReflexiveCandidate**(`protocol`, `stunServer`): `Promise`\<[`Candidate`](../classes/Candidate.md)\>

Query `stunServer` from `protocol` for a server-reflexive candidate.
Unlike [serverReflexiveCandidate](serverReflexiveCandidate.md) it rejects with the reason of a
failure: the STUN transaction's error (`TransactionTimeout`,
`TransactionFailed` for an error response, `TransactionCancelled`, a DNS
error, `AddressFamilyMismatch`), a [MissingMappedAddressError](../classes/MissingMappedAddressError.md) for a
success response without XOR-MAPPED-ADDRESS, or an `Error` when the
protocol has no local candidate (thrown before any request is sent).

## Parameters

### protocol

[`Protocol`](../interfaces/Protocol.md)

### stunServer

readonly \[`string`, `number`\]

## Returns

`Promise`\<[`Candidate`](../classes/Candidate.md)\>

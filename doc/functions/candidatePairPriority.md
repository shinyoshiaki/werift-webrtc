[**werift**](../README.md)

***

[werift](../globals.md) / candidatePairPriority

# Function: candidatePairPriority()

> **candidatePairPriority**(`local`, `remote`, `iceControlling`): `number`

`2^32 * MIN(G,D) + 2 * MAX(G,D) + (G > D ? 1 : 0)` (RFC 8445 §6.1.2.3).
The value can exceed `Number.MAX_SAFE_INTEGER`, so it is approximate;
order pairs with `compareCandidatePairPriority`, which is exact.

## Parameters

### local

`Pick`\<[`Candidate`](../classes/Candidate.md), `"priority"`\>

### remote

`Pick`\<[`Candidate`](../classes/Candidate.md), `"priority"`\>

### iceControlling

`boolean`

## Returns

`number`

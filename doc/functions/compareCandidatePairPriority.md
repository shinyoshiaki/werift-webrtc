[**werift**](../README.md)

***

[werift](../globals.md) / compareCandidatePairPriority

# Function: compareCandidatePairPriority()

> **compareCandidatePairPriority**(`aLocal`, `aRemote`, `bLocal`, `bRemote`, `iceControlling`): `number`

Exact comparison of two pair priorities (RFC 8445 §6.1.2.3): negative
when pair `a` has the lower priority, positive when the higher, 0 when equal.

## Parameters

### aLocal

`Pick`\<[`Candidate`](../classes/Candidate.md), `"priority"`\>

### aRemote

`Pick`\<[`Candidate`](../classes/Candidate.md), `"priority"`\>

### bLocal

`Pick`\<[`Candidate`](../classes/Candidate.md), `"priority"`\>

### bRemote

`Pick`\<[`Candidate`](../classes/Candidate.md), `"priority"`\>

### iceControlling

`boolean`

## Returns

`number`

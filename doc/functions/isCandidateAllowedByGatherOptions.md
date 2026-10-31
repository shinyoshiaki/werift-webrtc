[**werift**](../README.md)

***

[werift](../globals.md) / isCandidateAllowedByGatherOptions

# Function: isCandidateAllowedByGatherOptions()

> **isCandidateAllowedByGatherOptions**(`candidate`, `options`): `boolean`

Whether `candidate`, kept from an earlier generation (an ICE restart keeps
the sockets), may be advertised and paired in a generation gathered with
`options`. A fresh gathering with the same options would not have produced
a host / server-reflexive candidate for a relay-only policy, nor a TCP host
candidate without useTcp; the kept ones are held back the same way.

## Parameters

### candidate

`Pick`\<[`Candidate`](../classes/Candidate.md), `"type"` \| `"transport"`\>

### options

`Pick`\<[`IceOptions`](../interfaces/IceOptions.md), `"turnServer"` \| `"turnUsername"` \| `"turnPassword"` \| `"forceTurn"`\> & `object` & `Partial`\<`Pick`\<[`IceOptions`](../interfaces/IceOptions.md), `"useTcp"`\>\>

## Returns

`boolean`

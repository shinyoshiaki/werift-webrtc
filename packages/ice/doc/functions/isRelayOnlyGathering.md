[**werift-ice**](../README.md)

***

[werift-ice](../globals.md) / isRelayOnlyGathering

# Function: isRelayOnlyGathering()

> **isRelayOnlyGathering**(`options`): `boolean`

Whether a generation gathered with `options` is relay-only: forceTurn (the
"relay" ICE transport policy). The policy holds whatever the TURN settings
are: without a usable TURN server / credential (or for an ICE-lite agent,
which gathers no relay candidate) the generation has no candidate at all
rather than falling back to host / server-reflexive ones, so the local and
public addresses are neither advertised nor used for checks.

## Parameters

### options

`Pick`\<[`IceOptions`](../interfaces/IceOptions.md), `"forceTurn"`\>

## Returns

`boolean`

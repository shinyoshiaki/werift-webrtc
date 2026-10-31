[**werift-ice**](../README.md)

***

[werift-ice](../globals.md) / isRelayOnlyGathering

# Function: isRelayOnlyGathering()

> **isRelayOnlyGathering**(`options`): `boolean`

Whether a generation gathered with `options` is relay-only: forceTurn with
a complete TURN server and credential. Without one, forceTurn falls back to
gathering host / server-reflexive candidates as usual.

## Parameters

### options

`Pick`\<[`IceOptions`](../interfaces/IceOptions.md), `"turnServer"` \| `"turnUsername"` \| `"turnPassword"` \| `"forceTurn"`\> & `object`

## Returns

`boolean`

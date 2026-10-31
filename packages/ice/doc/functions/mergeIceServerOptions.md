[**werift-ice**](../README.md)

***

[werift-ice](../globals.md) / mergeIceServerOptions

# Function: mergeIceServerOptions()

> **mergeIceServerOptions**\<`T`\>(`current`, `update`): `T`

`current` with an ICE server update applied (Connection.setIceServers): the
STUN/TURN fields are replaced, an undefined one included, so a STUN-only
update cannot leave a previous TURN host/credential behind; forceTurn and
useTcp change only when given.

## Type Parameters

### T

`T` *extends* `Partial`\<[`IceOptions`](../interfaces/IceOptions.md)\>

## Parameters

### current

`T`

### update

`Partial`\<[`IceOptions`](../interfaces/IceOptions.md)\>

## Returns

`T`

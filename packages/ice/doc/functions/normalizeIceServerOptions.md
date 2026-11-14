[**werift-ice**](../README.md)

***

[werift-ice](../globals.md) / normalizeIceServerOptions

# Function: normalizeIceServerOptions()

> **normalizeIceServerOptions**(`options`): `object`

The STUN and TURN servers `options` configure, the one place the singular
(deprecated) and plural fields are merged:

- order: the singular server first, then the plural list in its order;
- duplicates (the same STUN address; the same TURN address, transport and
  credential) are kept once, at their first position;
- an invalid address (see [validateAddress](validateAddress.md)) is dropped, and so is a
  TURN server without username or password (it cannot allocate);
- a TURN transport left unset is "udp".

The built-in default STUN server is not added here; Connection falls back
to it when the result has no STUN server.

## Parameters

### options

[`IceServerFields`](../type-aliases/IceServerFields.md)

## Returns

`object`

### stunServers

> **stunServers**: (readonly \[`string`, `number`\])[]

### turnServers

> **turnServers**: `Required`\<[`TurnServerOptions`](../type-aliases/TurnServerOptions.md)\>[]

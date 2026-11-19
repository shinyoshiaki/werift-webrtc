[**werift**](../README.md)

***

[werift](../globals.md) / TurnServerOptions

# Type Alias: TurnServerOptions

> **TurnServerOptions** = `object`

A TURN server and the credential and transport used for it.

## Properties

### address

> **address**: [`Address`](Address.md)

***

### password

> **password**: `string`

***

### transport?

> `optional` **transport?**: `"udp"` \| `"tcp"` \| `"tls"`

Defaults to "udp" (with a TCP fallback when the UDP allocation fails).

***

### urls?

> `optional` **urls?**: `string`[]

The application's names (URLs) for this server. Metadata only: the
allocation does not use them. They are passed through unchanged to
IceServerRef.urls of `Connection.onIceCandidateError`, so a
failure can be matched to the configured server without exposing the
credential. Duplicates merged by [normalizeIceServerOptions](../functions/normalizeIceServerOptions.md) have
their urls merged.

***

### username

> **username**: `string`

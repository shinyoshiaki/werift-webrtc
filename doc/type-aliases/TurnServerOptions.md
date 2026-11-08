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

### username

> **username**: `string`

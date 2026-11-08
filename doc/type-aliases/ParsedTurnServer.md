[**werift**](../README.md)

***

[werift](../globals.md) / ParsedTurnServer

# Type Alias: ParsedTurnServer

> **ParsedTurnServer** = `object`

A TURN URL of `RTCIceServer.urls` with the credential of its `RTCIceServer`.

## Properties

### address

> **address**: [`Address`](Address.md)

***

### password?

> `optional` **password?**: `string`

***

### transport?

> `optional` **transport?**: `"udp"` \| `"tcp"` \| `"tls"`

From the URL (scheme / `?transport=`); undefined when it names none.

***

### username?

> `optional` **username?**: `string`

[**werift-ice**](../README.md)

***

[werift-ice](../globals.md) / IceServerRef

# Type Alias: IceServerRef

> **IceServerRef** = \{ `address`: `Address`; `kind`: `"stun"`; `urls?`: `string`[]; \} \| \{ `address`: `Address`; `kind`: `"turn"`; `transport`: `"udp"` \| `"tcp"` \| `"tls"`; `urls?`: `string`[]; \}

One STUN/TURN server of a gathering, as configured. `urls` are the
application's names for the server (`IceOptions.stunServerUrls`,
`TurnServerOptions.urls`), passed through unchanged; they are metadata
only and never carry a credential.

## Union Members

### Type Literal

\{ `address`: `Address`; `kind`: `"stun"`; `urls?`: `string`[]; \}

#### address

> **address**: `Address`

#### kind

> **kind**: `"stun"`

#### urls?

> `optional` **urls?**: `string`[]

The `stunServerUrls` entries of this address, when configured.

***

### Type Literal

\{ `address`: `Address`; `kind`: `"turn"`; `transport`: `"udp"` \| `"tcp"` \| `"tls"`; `urls?`: `string`[]; \}

#### address

> **address**: `Address`

#### kind

> **kind**: `"turn"`

#### transport

> **transport**: `"udp"` \| `"tcp"` \| `"tls"`

#### urls?

> `optional` **urls?**: `string`[]

`TurnServerOptions.urls` of the server, passed through.

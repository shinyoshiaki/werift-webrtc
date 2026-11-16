[**werift**](../README.md)

***

[werift](../globals.md) / IceServerRef

# Type Alias: IceServerRef

> **IceServerRef** = \{ `address`: [`Address`](Address.md); `kind`: `"stun"`; `urls?`: `string`[]; \} \| \{ `address`: [`Address`](Address.md); `kind`: `"turn"`; `transport`: `"udp"` \| `"tcp"` \| `"tls"`; `urls?`: `string`[]; \}

One STUN/TURN server of a gathering, as configured. `urls` are the
application's names for the server (`IceOptions.stunServerUrls`,
`TurnServerOptions.urls`), passed through unchanged; they are metadata
only and never carry a credential.

## Union Members

### Type Literal

\{ `address`: [`Address`](Address.md); `kind`: `"stun"`; `urls?`: `string`[]; \}

#### address

> **address**: [`Address`](Address.md)

#### kind

> **kind**: `"stun"`

#### urls?

> `optional` **urls?**: `string`[]

The `stunServerUrls` entries of this address, when configured.

***

### Type Literal

\{ `address`: [`Address`](Address.md); `kind`: `"turn"`; `transport`: `"udp"` \| `"tcp"` \| `"tls"`; `urls?`: `string`[]; \}

#### address

> **address**: [`Address`](Address.md)

#### kind

> **kind**: `"turn"`

#### transport

> **transport**: `"udp"` \| `"tcp"` \| `"tls"`

#### urls?

> `optional` **urls?**: `string`[]

`TurnServerOptions.urls` of the server, passed through.

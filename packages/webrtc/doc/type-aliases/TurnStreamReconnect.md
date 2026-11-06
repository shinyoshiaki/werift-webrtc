[**werift**](../README.md)

***

[werift](../globals.md) / TurnStreamReconnect

# Type Alias: TurnStreamReconnect

> **TurnStreamReconnect** = (`server`, `alternateDomain`) => `Promise`\<[`Transport`](../interfaces/Transport.md)\>

Opens a new stream transport to the TURN server named by a 300 (Try
Alternate) ALTERNATE-SERVER. `alternateDomain` is the ALTERNATE-DOMAIN
attribute, if any, which a TLS transport must validate the certificate
against (RFC 8489 §10).

## Parameters

### server

[`Address`](Address.md)

### alternateDomain

`string` \| `undefined`

## Returns

`Promise`\<[`Transport`](../interfaces/Transport.md)\>

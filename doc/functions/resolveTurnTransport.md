[**werift**](../README.md)

***

[werift](../globals.md) / resolveTurnTransport

# Function: resolveTurnTransport()

> **resolveTurnTransport**(`__namedParameters`): `"tcp"` \| `"tls"` \| `"udp"` \| `undefined`

The transport one TURN URL allocates over: the URL's own (scheme /
`?transport=`), else the configured `turnTransport`, else TCP for the
legacy `forceTurnTCP`, else undefined (UDP).

## Parameters

### \_\_namedParameters

#### configuredTurnTransport?

`"tcp"` \| `"tls"` \| `"udp"`

#### forceTurnTCP

`boolean`

#### parsedTurnTransport?

`"tcp"` \| `"tls"` \| `"udp"`

## Returns

`"tcp"` \| `"tls"` \| `"udp"` \| `undefined`

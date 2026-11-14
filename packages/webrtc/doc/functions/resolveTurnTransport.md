[**werift**](../README.md)

***

[werift](../globals.md) / resolveTurnTransport

# Function: resolveTurnTransport()

> **resolveTurnTransport**(`__namedParameters`): `"udp"` \| `"tcp"` \| `"tls"` \| `undefined`

The transport one TURN URL allocates over: the URL's own (scheme /
`?transport=`), else the configured `turnTransport`, else TCP for the
legacy `forceTurnTCP`, else undefined (UDP).

## Parameters

### \_\_namedParameters

#### configuredTurnTransport?

`"udp"` \| `"tcp"` \| `"tls"`

#### forceTurnTCP

`boolean`

#### parsedTurnTransport?

`"udp"` \| `"tcp"` \| `"tls"`

## Returns

`"udp"` \| `"tcp"` \| `"tls"` \| `undefined`

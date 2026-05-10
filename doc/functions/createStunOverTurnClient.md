[**werift**](../README.md)

***

[werift](../globals.md) / createStunOverTurnClient

# Function: createStunOverTurnClient()

> **createStunOverTurnClient**(`__namedParameters`, `__namedParameters`): `Promise`\<[`StunOverTurnProtocol`](../classes/StunOverTurnProtocol.md)\>

## Parameters

### \_\_namedParameters

#### address

readonly \[`string`, `number`\]

#### password

`string`

#### username

`string`

### \_\_namedParameters

#### interfaceAddresses?

[`InterfaceAddresses`](../type-aliases/InterfaceAddresses.md)

#### lifetime?

`number`

#### portRange?

\[`number`, `number`\]

#### ssl?

`boolean`

#### tlsOptions?

[`TlsConnectionOptions`](../type-aliases/TlsConnectionOptions.md)

#### transport?

`"tcp"` \| `"tls"` \| `"udp"`

## Returns

`Promise`\<[`StunOverTurnProtocol`](../classes/StunOverTurnProtocol.md)\>

[**werift**](../README.md)

***

[werift](../globals.md) / TurnClientOptions

# Interface: TurnClientOptions

## Properties

### connectTimeoutMs?

> `optional` **connectTimeoutMs**: `number`

Maximum time to wait for TCP/TLS connection establishment, in milliseconds.

***

### interfaceAddresses?

> `optional` **interfaceAddresses**: [`InterfaceAddresses`](../type-aliases/InterfaceAddresses.md)

***

### lifetime?

> `optional` **lifetime**: `number`

***

### portRange?

> `optional` **portRange**: \[`number`, `number`\]

***

### ssl?

> `optional` **ssl**: `boolean`

***

### tlsOptions?

> `optional` **tlsOptions**: [`TlsConnectionOptions`](../type-aliases/TlsConnectionOptions.md)

***

### transport?

> `optional` **transport**: `"tcp"` \| `"tls"` \| `"udp"`

***

### udpFamily?

> `optional` **udpFamily**: `4` \| `6`

Preferred IP family of the UDP socket, applied only when the server
address is a hostname. Ignored for an IP literal server address, whose
own family always selects the socket. Defaults to 4.

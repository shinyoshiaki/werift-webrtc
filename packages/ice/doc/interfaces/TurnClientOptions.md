[**werift-ice**](../README.md)

***

[werift-ice](../globals.md) / TurnClientOptions

# Interface: TurnClientOptions

## Properties

### connectTimeoutMs?

> `optional` **connectTimeoutMs**: `number`

Maximum time to wait for TCP/TLS connection establishment, in milliseconds.

***

### interfaceAddresses?

> `optional` **interfaceAddresses**: `InterfaceAddresses`

***

### lifetime?

> `optional` **lifetime**: `number`

***

### portRange?

> `optional` **portRange**: \[`number`, `number`\]

***

### signal?

> `optional` **signal**: `AbortSignal`

Aborting it while the allocation runs closes the client (its socket and
transactions) and rejects with `TransactionCancelled`.

***

### ssl?

> `optional` **ssl**: `boolean`

***

### tlsOptions?

> `optional` **tlsOptions**: `TlsConnectionOptions`

***

### transport?

> `optional` **transport**: `"udp"` \| `"tcp"` \| `"tls"`

***

### udpFamily?

> `optional` **udpFamily**: `4` \| `6`

Preferred IP family of the UDP socket, applied only when the server
address is a hostname. Ignored for an IP literal server address, whose
own family always selects the socket. Defaults to 4.

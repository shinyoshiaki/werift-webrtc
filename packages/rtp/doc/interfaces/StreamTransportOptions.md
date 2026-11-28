[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / StreamTransportOptions

# Interface: StreamTransportOptions

## Properties

### connectTimeoutMs?

> `optional` **connectTimeoutMs?**: `number`

Maximum time to wait for TCP/TLS connection establishment, in milliseconds.

***

### signal?

> `optional` **signal?**: `AbortSignal`

Aborting it while the connection is being established destroys the
socket and rejects `init()` with an `AbortError`. It is ignored once the
connection is established.

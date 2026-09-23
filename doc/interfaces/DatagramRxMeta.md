[**werift**](../README.md)

***

[werift](../globals.md) / DatagramRxMeta

# Interface: DatagramRxMeta

Optional per-datagram RX metadata threaded through [Transport.onData](Transport.md#ondata).
`rxGeneration` is an opaque carrier generation token (e.g. ICE generation):
the DTLS engine drops queued datagrams whose accept-time generation no
longer matches at queue-execution time (ICE restart race).

## Properties

### rxGeneration?

> `optional` **rxGeneration**: `number`

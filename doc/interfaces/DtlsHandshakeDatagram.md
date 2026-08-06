[**werift**](../README.md)

***

[werift](../globals.md) / DtlsHandshakeDatagram

# Interface: DtlsHandshakeDatagram

Minimal handshake datagram carrier for direct UDP and future SPED (Epic 2).
Shapes may evolve; capabilities are required.

## Properties

### bytes

> `readonly` **bytes**: `Buffer`

Defensive copy of serialized flight bytes (immutable after creation).

***

### flightId

> `readonly` **flightId**: `number`

***

### packetIndex

> `readonly` **packetIndex**: `number`

***

### retransmittable

> `readonly` **retransmittable**: `boolean`

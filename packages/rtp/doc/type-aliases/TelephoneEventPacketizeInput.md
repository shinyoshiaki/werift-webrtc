[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / TelephoneEventPacketizeInput

# Type Alias: TelephoneEventPacketizeInput

> **TelephoneEventPacketizeInput**: `object`

## Type declaration

### duration

> **duration**: `number`

Cumulative duration for this packet (RFC 4733 §2.5.1.2).

### end?

> `optional` **end**: `boolean`

True on the final packet(s) of the event (sets E bit).

### event

> **event**: `number`

### start?

> `optional` **start**: `boolean`

True on the first packet of a new event (sets RTP marker).
RFC 4733 §2.5.1.1: marker indicates beginning of a new event.

### volume

> **volume**: `number`

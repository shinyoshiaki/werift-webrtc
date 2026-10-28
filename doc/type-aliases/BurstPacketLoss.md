[**werift**](../README.md)

***

[werift](../globals.md) / BurstPacketLoss

# Type Alias: BurstPacketLoss

> **BurstPacketLoss** = `object`

Periodic (deterministic) burst loss for debugging.
Every `intervalMs` from the first RTP packet, RTP packets are dropped for
`durationMs`. Only RTP is dropped; RTCP and ICE/DTLS keep flowing, so the
loss hits media and retransmissions but not the NACKs themselves.

## Properties

### durationMs

> **durationMs**: `number`

Length of each drop window in ms.

***

### intervalMs

> **intervalMs**: `number`

Period of the drop windows in ms.

***

### offsetMs?

> `optional` **offsetMs?**: `number`

Delay from the first RTP packet to the first drop window in ms. Default `intervalMs - durationMs`.

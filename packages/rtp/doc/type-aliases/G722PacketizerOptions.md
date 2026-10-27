[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / G722PacketizerOptions

# Type Alias: G722PacketizerOptions

> **G722PacketizerOptions** = [`PacketizerBaseOptions`](PacketizerBaseOptions.md) & `object`

## Type Declaration

### frameDurationInMs?

> `optional` **frameDurationInMs?**: `number`

Frame duration in ms (default 20 → 160 octets @ 8000 octets/s,
and +160 on the RTP timestamp).

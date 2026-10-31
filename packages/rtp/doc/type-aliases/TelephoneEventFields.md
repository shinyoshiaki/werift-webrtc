[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / TelephoneEventFields

# Type Alias: TelephoneEventFields

> **TelephoneEventFields**: `object`

## Type declaration

### duration

> **duration**: `number`

Duration in timestamp units (clock-rate dependent).

### end

> **end**: `boolean`

End of event flag (RFC 4733 E bit).

### event

> **event**: `number`

Event code (0–255). DTMF 0–9, *, #, A–D use 0–15 (RFC 4733 Table 7).

### volume

> **volume**: `number`

Volume 0–63; larger values = lower volume (dBm0).

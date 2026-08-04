[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / AacHbrDepacketizerOptions

# Type Alias: AacHbrDepacketizerOptions

> **AacHbrDepacketizerOptions**: `object`

## Type declaration

### ctsDeltaLength?

> `optional` **ctsDeltaLength**: `number`

### ctsDtsPresent?

> `optional` **ctsDtsPresent**: `boolean`

When true, after each AU-header the parser expects CTS-flag (1) and
optionally CTS-delta / DTS-flag / DTS-delta if flags are set.
Default false (minimal AAC-hbr: size + index only).

### dtsDeltaLength?

> `optional` **dtsDeltaLength**: `number`

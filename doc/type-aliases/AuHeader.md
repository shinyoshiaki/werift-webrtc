[**werift**](../README.md)

***

[werift](../globals.md) / AuHeader

# Type Alias: AuHeader

> **AuHeader**: `object`

## Type declaration

### ctsDelta?

> `optional` **ctsDelta**: `number`

### dtsDelta?

> `optional` **dtsDelta**: `number`

### hasCts?

> `optional` **hasCts**: `boolean`

True when CTS-flag was present and set (extended parse only).

### hasDts?

> `optional` **hasDts**: `boolean`

True when DTS-flag was present and set (extended parse only).

### index

> **index**: `number`

AU-Index (first) or AU-Index-delta (subsequent).

### size

> **size**: `number`

Access Unit size in octets (RFC 3640 AU-size).
This is the byte count itself, not (bytes − 1).

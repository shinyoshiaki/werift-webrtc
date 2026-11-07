[**werift**](../README.md)

***

[werift](../globals.md) / AacHbrDepacketizerOptions

# Type Alias: AacHbrDepacketizerOptions

> **AacHbrDepacketizerOptions**: `object`

Options for extended AU-header parsing beyond default aac-hbr (size+index).
Default aac-hbr does not include CTS/DTS; pass these when SDP signals them
(e.g. generic mode with CTSDeltaLength / DTSDeltaLength).

## Type declaration

### ctsDeltaLength?

> `optional` **ctsDeltaLength**: `number`

Bit length of CTS-delta when CTS-flag=1 (default 14).

### ctsDtsPresent?

> `optional` **ctsDtsPresent**: `boolean`

When true, each AU-header after size+index includes CTS-flag (1 bit) and
optionally CTS-delta / DTS-flag / DTS-delta when flags are set (RFC 3640 §3.2.1.1).

### dtsDeltaLength?

> `optional` **dtsDeltaLength**: `number`

Bit length of DTS-delta when DTS-flag=1 (default 14).

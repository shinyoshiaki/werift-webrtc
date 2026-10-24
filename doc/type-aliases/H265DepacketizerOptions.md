[**werift**](../README.md)

***

[werift](../globals.md) / H265DepacketizerOptions

# Type Alias: H265DepacketizerOptions

> **H265DepacketizerOptions**: `object`

## Type declaration

### hasDonl?

> `optional` **hasDonl**: `boolean`

When true, skip conditional DONL (2 bytes) after PayloadHdr for single NAL
and after FU header when S=1 (RFC 7798 DONL presence via sprop-max-don-diff > 0).
Default false (non-interleaved).

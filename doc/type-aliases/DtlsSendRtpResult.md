[**werift**](../README.md)

***

[werift](../globals.md) / DtlsSendRtpResult

# Type Alias: DtlsSendRtpResult

> **DtlsSendRtpResult**: `object`

Result of encrypting and enqueueing one RTP packet on ICE.

## Type declaration

### sendingAtMs

> **sendingAtMs**: `number`

Local clock immediately before ICE/UDP enqueue (RFC 8888 send time).

### size

> **size**: `number`

On-wire SRTP size in bytes.

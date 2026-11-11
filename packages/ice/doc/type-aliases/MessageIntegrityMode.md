[**werift-ice**](../README.md)

***

[werift-ice](../globals.md) / MessageIntegrityMode

# Type Alias: MessageIntegrityMode

> **MessageIntegrityMode** = [`MessageIntegrityAlgorithm`](MessageIntegrityAlgorithm.md) \| `"both"`

Which integrity attributes an outgoing message carries. `"both"` adds
MESSAGE-INTEGRITY followed by MESSAGE-INTEGRITY-SHA256 (RFC 8489 §14.6
order), so an agent that only knows SHA-1 can still verify it.

[**werift**](../README.md)

***

[werift](../globals.md) / RtpHeaderDeSerializeOptions

# Type Alias: RtpHeaderDeSerializeOptions

> **RtpHeaderDeSerializeOptions**: `object`

## Type declaration

### validatePadding?

> `optional` **validatePadding**: `boolean`

When true (default), RFC 3550 padding length is validated:
1..`packet.length - payloadOffset`.
SRTP header parse must pass false because the last octet is still
ciphertext until authentication completes.

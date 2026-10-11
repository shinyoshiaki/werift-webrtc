[**werift**](../README.md)

***

[werift](../globals.md) / PendingRtpOptions

# Type Alias: PendingRtpOptions

> **PendingRtpOptions**: `object`

## Type declaration

### enabled?

> `optional` **enabled**: `boolean`

Queue RTP until DTLS is connected and a codec is set. Default true when this object is passed.

### maxLength?

> `optional` **maxLength**: `number`

Max queued packets when enabled. Oldest packets are dropped. Default 256.

[**werift-ice**](../README.md)

***

[werift-ice](../globals.md) / parseMessage

# Function: parseMessage()

> **parseMessage**(`data`, `integrityKey`?): `undefined` \| [`Message`](../classes/Message.md)

## Parameters

### data

`Buffer`

### integrityKey?

`Buffer`\<`ArrayBufferLike`\>

When provided, `MESSAGE-INTEGRITY` must be present and valid
(RFC 5389 short-term credentials / RFC 7675 authenticated consent).
Unsigned messages return `undefined`.

## Returns

`undefined` \| [`Message`](../classes/Message.md)

[**werift**](../README.md)

***

[werift](../globals.md) / appendRfc3550Padding

# Function: appendRfc3550Padding()

> **appendRfc3550Padding**(`payload`, `paddingSize`): `Buffer`

Append RFC 3550 padding to an RTP payload.
The last octet is the padding length (including itself); preceding pad bytes are zero.

## Parameters

### payload

`Buffer`

### paddingSize

`number`

total padding octets in [1, 255]

## Returns

`Buffer`

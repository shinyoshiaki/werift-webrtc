[**werift**](../README.md)

***

[werift](../globals.md) / assertDataChannelFieldLengths

# Function: assertDataChannelFieldLengths()

> **assertDataChannelFieldLengths**(`fields`): `void`

Label / Protocol Length are 16-bit byte counts of the UTF-8 fields
(RFC 8832 5.1); W3C createDataChannel rejects longer values for both
negotiated and in-band channels. Call before any state is touched.

## Parameters

### fields

#### label

`string`

#### protocol?

`string`

## Returns

`void`

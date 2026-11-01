[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / createVp8PayloadDescriptor

# Function: createVp8PayloadDescriptor()

> **createVp8PayloadDescriptor**(`__namedParameters`): `Buffer`

Build the 4-octet VP8 payload descriptor X=1, I=1, M=1 (RFC 7741 §4.2).
`start` sets S (first packet of the frame, PID=0).

## Parameters

### \_\_namedParameters

#### pictureId

`number`

#### start

`boolean`

## Returns

`Buffer`

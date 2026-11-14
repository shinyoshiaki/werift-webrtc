[**werift**](../README.md)

***

[werift](../globals.md) / IceCandidateErrorInfo

# Type Alias: IceCandidateErrorInfo

> **IceCandidateErrorInfo** = `object`

A STUN or TURN server a gathering used could not give a candidate
(`Connection.onIceCandidateError`). Reported at most once per server, local
socket and generation (a 701 once per server and generation, when no
socket reached it), only for the generation gathering and never after
close.

## Properties

### address?

> `optional` **address?**: `string`

Local address used to contact the server; undefined when unknown or hidden.

***

### errorCode

> **errorCode**: `number`

STUN error code (300-699) the server answered with, or
[IceCandidateErrorCode.SERVER\_NOT\_REACHED](../enumerations/IceCandidateErrorCode.md#server_not_reached) (701) when no answer
came.

***

### errorText

> **errorText**: `string`

The server's reason phrase with the credential material werift knows
masked (gatherErrorReasonText; the registered phrase when it is
empty), or a description of the 701 cause.

***

### generation

> **generation**: `number`

Gathering generation the failure belongs to.

***

### port?

> `optional` **port?**: `number`

Local port; undefined when `address` is.

***

### server

> **server**: [`IceServerRef`](IceServerRef.md)

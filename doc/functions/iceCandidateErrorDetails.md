[**werift**](../README.md)

***

[werift](../globals.md) / iceCandidateErrorDetails

# Function: iceCandidateErrorDetails()

> **iceCandidateErrorDetails**(`info`, `relayOnly`): [`IceCandidateErrorDetails`](../type-aliases/IceCandidateErrorDetails.md)[]

The `icecandidateerror` members of an ICE agent's server failure: one per
configured URL of the server (none for a server without one, such as the
built-in default STUN server). The local address is given only when the
agent knows it and the ICE transport policy is not "relay"; otherwise it
and port are `null` (W3C: a null address has a null port).

## Parameters

### info

[`IceCandidateErrorInfo`](../type-aliases/IceCandidateErrorInfo.md)

### relayOnly

`boolean`

## Returns

[`IceCandidateErrorDetails`](../type-aliases/IceCandidateErrorDetails.md)[]

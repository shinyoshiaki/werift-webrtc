[**werift**](../README.md)

***

[werift](../globals.md) / iceCandidateErrorDetails

# Function: iceCandidateErrorDetails()

> **iceCandidateErrorDetails**(`info`, `relayOnly`): [`IceCandidateErrorDetails`](../type-aliases/IceCandidateErrorDetails.md)[]

The `icecandidateerror` members of an ICE agent's server failure: one per
URL of the server (the configured ones, or the synthesized URL of the
built-in default STUN server). The local address is given only when the
agent knows it and the ICE transport policy is not "relay"; otherwise
`address` is `null` and `port` 0 (as Chrome and the WPT tests).

## Parameters

### info

[`IceCandidateErrorInfo`](../type-aliases/IceCandidateErrorInfo.md)

### relayOnly

`boolean`

## Returns

[`IceCandidateErrorDetails`](../type-aliases/IceCandidateErrorDetails.md)[]

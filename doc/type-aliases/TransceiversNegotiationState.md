[**werift**](../README.md)

***

[werift](../globals.md) / TransceiversNegotiationState

# Type Alias: TransceiversNegotiationState

> **TransceiversNegotiationState**: `object`

The transceivers of a PeerConnection and their negotiation state.

## Type declaration

### order

> **order**: [`RTCRtpTransceiver`](../classes/RTCRtpTransceiver.md)[]

### states

> **states**: `Map`\<[`RTCRtpTransceiver`](../classes/RTCRtpTransceiver.md), \{ `notifiedRemoteTrack`: \{ `streams`: `string`[]; `track`: [`MediaStreamTrack`](../classes/MediaStreamTrack.md); \}; `transceiver`: [`TransceiverNegotiationState`](TransceiverNegotiationState.md); \}\>

[**werift**](../README.md)

***

[werift](../globals.md) / RTCIceGatheringErrorEvent

# Type Alias: RTCIceGatheringErrorEvent

> **RTCIceGatheringErrorEvent** = [`IceGatheringErrorDetails`](IceGatheringErrorDetails.md) & `object`

A gathering error of one ICE transport (`RTCPeerConnection.onIceGatheringError`,
a werift extension, not W3C): see [IceGatheringErrorDetails](IceGatheringErrorDetails.md).

## Type Declaration

### iceTransport

> `readonly` **iceTransport**: [`RTCIceTransport`](../classes/RTCIceTransport.md)

The transport whose gathering reported it.

## See

packages/webrtc/tests/transport/iceGatheringError.test.ts「without STUN / TURN: gathering completes with end-of-candidates and both reasons are reported」

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

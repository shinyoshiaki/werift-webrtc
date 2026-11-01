[**werift**](../README.md)

***

[werift](../globals.md) / useGoogleStun

# Function: useGoogleStun()

> **useGoogleStun**(): [`RTCIceServer`](../type-aliases/RTCIceServer.md)

The RTCIceServer entry of Google's public STUN server
(`stun:stun.l.google.com:19302`). werift uses no STUN server unless one is
configured; opt in with `iceServers: [useGoogleStun()]` (combine it with
TURN entries as needed).

## Returns

[`RTCIceServer`](../type-aliases/RTCIceServer.md)

[**werift**](../README.md)

***

[werift](../globals.md) / RTCConfiguration

# Interface: RTCConfiguration

## Properties

### bundlePolicy?

> `optional` **bundlePolicy?**: [`RTCBundlePolicy`](../type-aliases/RTCBundlePolicy.md)

***

### certificates?

> `optional` **certificates?**: [`RTCCertificate`](../classes/RTCCertificate.md)[]

***

### iceCandidatePoolSize?

> `optional` **iceCandidatePoolSize?**: `number`

***

### iceServers?

> `optional` **iceServers?**: [`RTCIceServer`](../type-aliases/RTCIceServer.md)[]

STUN / TURN servers used for ICE gathering. Defaults to `[]`; no public
STUN server is used implicitly. To use Google STUN, specify
`[{ urls: "stun:stun.l.google.com:19302" }]` explicitly.

***

### iceTransportPolicy?

> `optional` **iceTransportPolicy?**: `"relay"` \| `"all"`

***

### rtcpMuxPolicy?

> `optional` **rtcpMuxPolicy?**: `"require"`

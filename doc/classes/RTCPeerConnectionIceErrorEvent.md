[**werift**](../README.md)

***

[werift](../globals.md) / RTCPeerConnectionIceErrorEvent

# Class: RTCPeerConnectionIceErrorEvent

`icecandidateerror` (W3C WebRTC §4.8.2): a configured STUN or TURN server
could not give a candidate while gathering. `RTCPeerConnection` fires one
per failing server URL, local socket and gathering generation, never after
`close()`.

- `url`: the configured URL of the server, canonical: trimmed, lower-case
  scheme, and `?transport=tcp` added to a `turns:` URL that names no
  transport (`turns:h:5349` → `turns:h:5349?transport=tcp`, the Chrome /
  WPT form). Several URLs naming one server each get their own event. The
  built-in default STUN server (`iceUseDefaultStunServer`) has no URL in
  the configuration and is not reported.
- `errorCode`: the STUN error code the server answered with (300-699),
  or 701 when it was not reached (DNS, timeout, connect or socket error).
- `errorText`: the server's reason phrase or a fixed description; it never
  contains a credential.
- `address` / `port`: the local host address used to contact a STUN
  server; `null` / `0` when unknown (TURN) or hidden (the `"relay"` ICE
  transport policy).

## Constructors

### Constructor

> **new RTCPeerConnectionIceErrorEvent**(`type`, `init`): `RTCPeerConnectionIceErrorEvent`

#### Parameters

##### type

`string`

##### init

[`RTCPeerConnectionIceErrorEventInit`](../interfaces/RTCPeerConnectionIceErrorEventInit.md)

#### Returns

`RTCPeerConnectionIceErrorEvent`

## Properties

### address

> `readonly` **address**: `string` \| `null`

***

### errorCode

> `readonly` **errorCode**: `number`

***

### errorText

> `readonly` **errorText**: `string`

***

### port

> `readonly` **port**: `number` \| `null`

***

### type

> `readonly` **type**: `string`

***

### url

> `readonly` **url**: `string`

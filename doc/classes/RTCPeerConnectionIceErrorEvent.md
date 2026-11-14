[**werift**](../README.md)

***

[werift](../globals.md) / RTCPeerConnectionIceErrorEvent

# Class: RTCPeerConnectionIceErrorEvent

`icecandidateerror` (W3C WebRTC §4.8.2): a configured STUN or TURN server
could not give a candidate while gathering. `RTCPeerConnection` fires one
per failing server URL and gathering generation, never after `close()`.
A server that answered with an error (300-699) is reported once per local
socket that asked it. A 701 (not reached) means no host candidate reached
the server: it is fired once per URL per gathering (until
`iceGatheringState` enters "gathering" again, as after an ICE restart),
and only when no local socket of any ICE transport taking part in that
gathering reached it (a transport that only gathered in an earlier one,
such as an existing transport when a new m-line adds one with
`bundlePolicy: "disable"`, does not count). While
listeners run, `target` and `currentTarget` are the
`RTCPeerConnection` and `eventPhase` is 2 (`AT_TARGET`); afterwards
`currentTarget` is `null` and `eventPhase` 0.

- `url`: the configured URL of the server, canonical: trimmed, lower-case
  scheme, and `?transport=tcp` added to a `turns:` URL that names no
  transport (`turns:h:5349` → `turns:h:5349?transport=tcp`, the Chrome /
  WPT form). Several URLs naming one server each get their own event. The
  built-in default STUN server (`iceUseDefaultStunServer`, used when no
  STUN server is configured) is in no configuration; werift reports it
  with the synthesized URL `stun:stun.l.google.com:19302`.
- `errorCode`: the STUN error code the server answered with (300-699),
  or 701 when it was not reached (DNS, timeout, connect or socket error).
- `errorText`: the server's reason phrase or a fixed description; it never
  contains a credential.
- `address` / `port`: the local host address used to contact a STUN
  server; `null` / `0` when unknown (TURN) or hidden (the `"relay"` ICE
  transport policy), as Chrome and the WPT tests (`port == 0` when
  `address` is `null`).

## Extends

- `Event`

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

#### Overrides

`Event.constructor`

## Properties

### address

> `readonly` **address**: `string` \| `null`

***

### bubbles

> `readonly` **bubbles**: `boolean`

#### Inherited from

`Event.bubbles`

***

### cancelable

> `readonly` **cancelable**: `boolean`

#### Inherited from

`Event.cancelable`

***

### cancelBubble

> **cancelBubble**: `boolean`

#### Inherited from

`Event.cancelBubble`

***

### composed

> `readonly` **composed**: `boolean`

#### Inherited from

`Event.composed`

***

### currentTarget

> `readonly` **currentTarget**: `EventTarget` \| `null`

#### Inherited from

`Event.currentTarget`

***

### defaultPrevented

> `readonly` **defaultPrevented**: `boolean`

#### Inherited from

`Event.defaultPrevented`

***

### errorCode

> `readonly` **errorCode**: `number`

***

### errorText

> `readonly` **errorText**: `string`

***

### eventPhase

> `readonly` **eventPhase**: `0` \| `2`

#### Inherited from

`Event.eventPhase`

***

### isTrusted

> `readonly` **isTrusted**: `boolean`

#### Inherited from

`Event.isTrusted`

***

### port

> `readonly` **port**: `number` \| `null`

***

### returnValue

> **returnValue**: `boolean`

#### Inherited from

`Event.returnValue`

***

### srcElement

> `readonly` **srcElement**: `EventTarget` \| `null`

#### Inherited from

`Event.srcElement`

***

### target

> `readonly` **target**: `EventTarget` \| `null`

#### Inherited from

`Event.target`

***

### timeStamp

> `readonly` **timeStamp**: `number`

#### Inherited from

`Event.timeStamp`

***

### type

> `readonly` **type**: `string`

#### Inherited from

`Event.type`

***

### url

> `readonly` **url**: `string`

## Methods

### composedPath()

> **composedPath**(): \[`EventTarget`?\]

#### Returns

\[`EventTarget`?\]

#### Inherited from

`Event.composedPath`

***

### initEvent()

> **initEvent**(`type`, `bubbles?`, `cancelable?`): `void`

#### Parameters

##### type

`string`

##### bubbles?

`boolean`

##### cancelable?

`boolean`

#### Returns

`void`

#### Inherited from

`Event.initEvent`

***

### preventDefault()

> **preventDefault**(): `void`

#### Returns

`void`

#### Inherited from

`Event.preventDefault`

***

### stopImmediatePropagation()

> **stopImmediatePropagation**(): `void`

#### Returns

`void`

#### Inherited from

`Event.stopImmediatePropagation`

***

### stopPropagation()

> **stopPropagation**(): `void`

#### Returns

`void`

#### Inherited from

`Event.stopPropagation`

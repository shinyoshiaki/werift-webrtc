[**werift**](../README.md)

***

[werift](../globals.md) / RTCSessionDescription

# Class: RTCSessionDescription

A session description (W3C `RTCSessionDescription`).

- `new RTCSessionDescription({ type, sdp })`: the W3C constructor, with
  the WebIDL dictionary conversion: `undefined` / `null` is an empty
  dictionary and any other non-object is a `TypeError`; the members are
  read once each in dictionary order (`sdp`, then `type`); `sdp` defaults
  to `""` only when it is `undefined` and is otherwise converted with
  `ToString` (`null` is `"null"`, a Symbol is a `TypeError`); `type` is
  required and converted with `ToString` before it is matched (a missing
  or unknown value is a `TypeError`). Extra arguments are ignored.
- `new RTCSessionDescription(sdp, type)`: werift's original form, chosen
  only when the first argument is a string; kept for backward
  compatibility (not validated).

`werift/polyfill` installs this same class as the global
`RTCSessionDescription`, so `instanceof` holds from both sides.

## Constructors

### Constructor

> **new RTCSessionDescription**(`init`): `RTCSessionDescription`

#### Parameters

##### init

[`RTCSessionDescriptionConstructorInit`](../interfaces/RTCSessionDescriptionConstructorInit.md)

#### Returns

`RTCSessionDescription`

### Constructor

> **new RTCSessionDescription**(`sdp`, `type`): `RTCSessionDescription`

#### Parameters

##### sdp

`string`

##### type

`"offer"` \| `"answer"` \| `"pranswer"`

#### Returns

`RTCSessionDescription`

## Properties

### sdp

> `readonly` **sdp**: `string`

***

### type

> `readonly` **type**: [`RTCSdpType`](../type-aliases/RTCSdpType.md)

## Methods

### toJSON()

> **toJSON**(): `object`

W3C `toJSON()`: exactly `type` and `sdp`. The key order (`sdp` first)
keeps `JSON.stringify` output as it was before `toJSON` existed.

#### Returns

`object`

##### sdp

> **sdp**: `string`

##### type

> **type**: [`RTCSdpType`](../type-aliases/RTCSdpType.md)

***

### toSdp()

> **toSdp**(): `object`

#### Returns

`object`

##### sdp

> **sdp**: `string`

##### type

> **type**: [`RTCSdpType`](../type-aliases/RTCSdpType.md)

***

### isThis()

> `static` **isThis**(`o`): `true` \| `undefined`

#### Parameters

##### o

`any`

#### Returns

`true` \| `undefined`

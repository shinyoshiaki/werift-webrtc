[**werift**](../README.md)

***

[werift](../globals.md) / RTCSessionDescription

# Class: RTCSessionDescription

A session description (W3C `RTCSessionDescription`).

- `new RTCSessionDescription({ type, sdp })`: the W3C constructor. `type`
  is required (a missing or unknown value is a `TypeError`), `sdp`
  defaults to `""`.
- `new RTCSessionDescription(sdp, type)`: werift's original form, kept
  for backward compatibility (not validated).

`werift/polyfill` installs this same class as the global
`RTCSessionDescription`, so `instanceof` holds from both sides.

## Constructors

### Constructor

> **new RTCSessionDescription**(`init`): `RTCSessionDescription`

#### Parameters

##### init

[`RTCSessionDescriptionInit`](../interfaces/RTCSessionDescriptionInit.md)

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

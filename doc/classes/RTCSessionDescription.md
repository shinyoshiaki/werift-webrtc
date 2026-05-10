[**werift**](../README.md)

***

[werift](../globals.md) / RTCSessionDescription

# Class: RTCSessionDescription

## Constructors

### new RTCSessionDescription()

> **new RTCSessionDescription**(`sdp`, `type`): [`RTCSessionDescription`](RTCSessionDescription.md)

#### Parameters

##### sdp

`string`

##### type

`"offer"` | `"answer"` | `"pranswer"`

#### Returns

[`RTCSessionDescription`](RTCSessionDescription.md)

## Properties

### sdp

> **sdp**: `string`

***

### type

> **type**: `"offer"` \| `"answer"` \| `"pranswer"`

## Methods

### toSdp()

> **toSdp**(): `object`

#### Returns

`object`

##### sdp

> **sdp**: `string`

##### type

> **type**: `"offer"` \| `"answer"` \| `"pranswer"`

***

### isThis()

> `static` **isThis**(`o`): `undefined` \| `true`

#### Parameters

##### o

`any`

#### Returns

`undefined` \| `true`

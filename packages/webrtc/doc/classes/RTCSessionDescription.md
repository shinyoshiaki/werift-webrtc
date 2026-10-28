[**werift**](../README.md)

***

[werift](../globals.md) / RTCSessionDescription

# Class: RTCSessionDescription

## Constructors

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

> `readonly` **type**: `"offer"` \| `"answer"` \| `"pranswer"`

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

> `static` **isThis**(`o`): `true` \| `undefined`

#### Parameters

##### o

`any`

#### Returns

`true` \| `undefined`

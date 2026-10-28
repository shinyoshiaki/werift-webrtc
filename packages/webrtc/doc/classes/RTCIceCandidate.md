[**werift**](../README.md)

***

[werift](../globals.md) / RTCIceCandidate

# Class: RTCIceCandidate

## Constructors

### Constructor

> **new RTCIceCandidate**(`props`): `RTCIceCandidate`

#### Parameters

##### props

`Partial`\<`RTCIceCandidate`\>

#### Returns

`RTCIceCandidate`

## Properties

### candidate

> **candidate**: `string`

***

### sdpMid?

> `optional` **sdpMid?**: `string`

***

### sdpMLineIndex?

> `optional` **sdpMLineIndex?**: `number`

***

### usernameFragment?

> `optional` **usernameFragment?**: `string`

## Methods

### toJSON()

> **toJSON**(): `object`

#### Returns

`object`

##### candidate

> **candidate**: `string`

##### sdpMid

> **sdpMid**: `string` \| `undefined`

##### sdpMLineIndex

> **sdpMLineIndex**: `number` \| `undefined`

##### usernameFragment

> **usernameFragment**: `string` \| `undefined`

***

### fromSdp()

> `static` **fromSdp**(`sdp`): `RTCIceCandidate`

#### Parameters

##### sdp

`string`

#### Returns

`RTCIceCandidate`

***

### isThis()

> `static` **isThis**(`o`): `true` \| `undefined`

#### Parameters

##### o

`any`

#### Returns

`true` \| `undefined`

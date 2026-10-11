[**werift**](../README.md)

***

[werift](../globals.md) / RTCIceCandidate

# Class: RTCIceCandidate

## Constructors

### new RTCIceCandidate()

> **new RTCIceCandidate**(`props`): [`RTCIceCandidate`](RTCIceCandidate.md)

#### Parameters

##### props

`Partial`\<[`RTCIceCandidate`](RTCIceCandidate.md)\>

#### Returns

[`RTCIceCandidate`](RTCIceCandidate.md)

## Properties

### candidate

> **candidate**: `string`

***

### sdpMid?

> `optional` **sdpMid**: `string`

***

### sdpMLineIndex?

> `optional` **sdpMLineIndex**: `number`

***

### usernameFragment?

> `optional` **usernameFragment**: `string`

## Methods

### toJSON()

> **toJSON**(): `object`

#### Returns

`object`

##### candidate

> **candidate**: `string`

##### sdpMid

> **sdpMid**: `undefined` \| `string`

##### sdpMLineIndex

> **sdpMLineIndex**: `undefined` \| `number`

##### usernameFragment

> **usernameFragment**: `undefined` \| `string`

***

### fromSdp()

> `static` **fromSdp**(`sdp`): [`RTCIceCandidate`](RTCIceCandidate.md)

#### Parameters

##### sdp

`string`

#### Returns

[`RTCIceCandidate`](RTCIceCandidate.md)

***

### isThis()

> `static` **isThis**(`o`): `undefined` \| `true`

#### Parameters

##### o

`any`

#### Returns

`undefined` \| `true`

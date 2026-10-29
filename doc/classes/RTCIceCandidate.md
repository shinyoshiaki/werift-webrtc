[**werift**](../README.md)

***

[werift](../globals.md) / RTCIceCandidate

# Class: RTCIceCandidate

Browser-shaped ICE candidate. Besides the signaling fields it exposes the
readonly fields of the W3C interface parsed from the candidate a-line
(`foundation`, `component`, `priority`, `address`, `protocol`, `port`,
`type`, `tcpType`, `relatedAddress`, `relatedPort`; `null` when absent or
unparsable). Candidates werift creates carry them without reparsing;
`toJSON()` keeps only the signaling fields (RTCIceCandidateInit).
`relayProtocol` and `url` are not implemented.

## Implements

- [`RTCIceCandidateFields`](../interfaces/RTCIceCandidateFields.md)

## Constructors

### Constructor

> **new RTCIceCandidate**(`props?`): `RTCIceCandidate`

The parsed fields are taken from `props` when any of them is given (an
already parsed candidate), and parsed from `props.candidate` otherwise.

#### Parameters

##### props?

`Partial`\<`Pick`\<`RTCIceCandidate`, `"usernameFragment"` \| `"candidate"` \| `"sdpMid"` \| `"sdpMLineIndex"`\>\> & `Partial`\<[`RTCIceCandidateFields`](../interfaces/RTCIceCandidateFields.md)\> = `{}`

#### Returns

`RTCIceCandidate`

## Properties

### address

> `readonly` **address**: `string` \| `null`

#### Implementation of

[`RTCIceCandidateFields`](../interfaces/RTCIceCandidateFields.md).[`address`](../interfaces/RTCIceCandidateFields.md#address)

***

### candidate

> **candidate**: `string`

***

### component

> `readonly` **component**: [`RTCIceComponent`](../type-aliases/RTCIceComponent.md) \| `null`

#### Implementation of

[`RTCIceCandidateFields`](../interfaces/RTCIceCandidateFields.md).[`component`](../interfaces/RTCIceCandidateFields.md#component)

***

### foundation

> `readonly` **foundation**: `string` \| `null`

#### Implementation of

[`RTCIceCandidateFields`](../interfaces/RTCIceCandidateFields.md).[`foundation`](../interfaces/RTCIceCandidateFields.md#foundation)

***

### port

> `readonly` **port**: `number` \| `null`

#### Implementation of

[`RTCIceCandidateFields`](../interfaces/RTCIceCandidateFields.md).[`port`](../interfaces/RTCIceCandidateFields.md#port)

***

### priority

> `readonly` **priority**: `number` \| `null`

#### Implementation of

[`RTCIceCandidateFields`](../interfaces/RTCIceCandidateFields.md).[`priority`](../interfaces/RTCIceCandidateFields.md#priority)

***

### protocol

> `readonly` **protocol**: [`RTCIceProtocol`](../type-aliases/RTCIceProtocol.md) \| `null`

#### Implementation of

[`RTCIceCandidateFields`](../interfaces/RTCIceCandidateFields.md).[`protocol`](../interfaces/RTCIceCandidateFields.md#protocol)

***

### relatedAddress

> `readonly` **relatedAddress**: `string` \| `null`

#### Implementation of

[`RTCIceCandidateFields`](../interfaces/RTCIceCandidateFields.md).[`relatedAddress`](../interfaces/RTCIceCandidateFields.md#relatedaddress)

***

### relatedPort

> `readonly` **relatedPort**: `number` \| `null`

#### Implementation of

[`RTCIceCandidateFields`](../interfaces/RTCIceCandidateFields.md).[`relatedPort`](../interfaces/RTCIceCandidateFields.md#relatedport)

***

### sdpMid?

> `optional` **sdpMid?**: `string`

***

### sdpMLineIndex?

> `optional` **sdpMLineIndex?**: `number`

***

### tcpType

> `readonly` **tcpType**: [`RTCIceTcpCandidateType`](../type-aliases/RTCIceTcpCandidateType.md) \| `null`

#### Implementation of

[`RTCIceCandidateFields`](../interfaces/RTCIceCandidateFields.md).[`tcpType`](../interfaces/RTCIceCandidateFields.md#tcptype)

***

### type

> `readonly` **type**: [`RTCIceCandidateType`](../type-aliases/RTCIceCandidateType.md) \| `null`

#### Implementation of

[`RTCIceCandidateFields`](../interfaces/RTCIceCandidateFields.md).[`type`](../interfaces/RTCIceCandidateFields.md#type)

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

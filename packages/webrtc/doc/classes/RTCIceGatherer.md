[**werift**](../README.md)

***

[werift](../globals.md) / RTCIceGatherer

# Class: RTCIceGatherer

## Constructors

### Constructor

> **new RTCIceGatherer**(`options?`): `RTCIceGatherer`

#### Parameters

##### options?

`Partial`\<[`IceOptions`](../interfaces/IceOptions.md)\> = `{}`

#### Returns

`RTCIceGatherer`

## Properties

### connection

> `readonly` **connection**: [`IceConnection`](../interfaces/IceConnection.md)

***

### gatheringState

> **gatheringState**: `"complete"` \| `"new"` \| `"gathering"` = `"new"`

***

### onGatheringStateChange

> `readonly` **onGatheringStateChange**: [`Event`](Event.md)\<\[`"complete"` \| `"new"` \| `"gathering"`\]\>

***

### onIceCandidate

> **onIceCandidate**: (`candidate`) => `void`

#### Parameters

##### candidate

[`IceCandidate`](IceCandidate.md) \| `undefined`

#### Returns

`void`

## Accessors

### localCandidates

#### Get Signature

> **get** **localCandidates**(): [`IceCandidate`](IceCandidate.md)[]

##### Returns

[`IceCandidate`](IceCandidate.md)[]

***

### localParameters

#### Get Signature

> **get** **localParameters**(): [`RTCIceParameters`](RTCIceParameters.md)

##### Returns

[`RTCIceParameters`](RTCIceParameters.md)

## Methods

### gather()

> **gather**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

***

### setGatheringState()

> **setGatheringState**(`state`): `void`

Set gathering state and notify listeners.
ICE restart must use this instead of writing gatheringState directly so
SecureTransportManager can refresh its aggregate iceGatheringState.

#### Parameters

##### state

`"complete"` \| `"new"` \| `"gathering"`

#### Returns

`void`

***

### setIceServers()

> **setIceServers**(`options`): `void`

#### Parameters

##### options

`Partial`\<[`IceOptions`](../interfaces/IceOptions.md)\>

#### Returns

`void`

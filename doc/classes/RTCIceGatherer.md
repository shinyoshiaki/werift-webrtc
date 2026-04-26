[**werift**](../README.md) • **Docs**

***

[werift](../globals.md) / RTCIceGatherer

# Class: RTCIceGatherer

## Constructors

### new RTCIceGatherer()

> **new RTCIceGatherer**(`options`): [`RTCIceGatherer`](RTCIceGatherer.md)

#### Parameters

• **options**: `Partial`\<[`IceOptions`](../interfaces/IceOptions.md)\> = `{}`

#### Returns

[`RTCIceGatherer`](RTCIceGatherer.md)

## Properties

### connection

> `readonly` **connection**: [`IceConnection`](../interfaces/IceConnection.md)

***

### gatheringState

> **gatheringState**: `"complete"` \| `"new"` \| `"gathering"` = `"new"`

***

### onGatheringStateChange

> `readonly` **onGatheringStateChange**: [`Event`](Event.md)\<[`"complete"` \| `"new"` \| `"gathering"`]\>

***

### onIceCandidate()

> **onIceCandidate**: (`candidate`) => `void`

#### Parameters

• **candidate**: `undefined` \| [`IceCandidate`](IceCandidate.md)

#### Returns

`void`

## Accessors

### localCandidates

> `get` **localCandidates**(): [`IceCandidate`](IceCandidate.md)[]

#### Returns

[`IceCandidate`](IceCandidate.md)[]

***

### localParameters

> `get` **localParameters**(): [`RTCIceParameters`](RTCIceParameters.md)

#### Returns

[`RTCIceParameters`](RTCIceParameters.md)

## Methods

### gather()

> **gather**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

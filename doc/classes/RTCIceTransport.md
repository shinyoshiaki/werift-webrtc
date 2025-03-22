[**werift**](../README.md) • **Docs**

***

[werift](../globals.md) / RTCIceTransport

# Class: RTCIceTransport

## Constructors

### new RTCIceTransport()

> **new RTCIceTransport**(`iceGather`): [`RTCIceTransport`](RTCIceTransport.md)

#### Parameters

• **iceGather**: [`RTCIceGatherer`](RTCIceGatherer.md)

#### Returns

[`RTCIceTransport`](RTCIceTransport.md)

## Properties

### connection

> **connection**: [`IceConnection`](../interfaces/IceConnection.md)

***

### id

> `readonly` **id**: `string`

***

### onIceCandidate

> `readonly` **onIceCandidate**: [`Event`](Event.md)\<[`undefined` \| [`IceCandidate`](IceCandidate.md)]\>

***

### onNegotiationNeeded

> `readonly` **onNegotiationNeeded**: [`Event`](Event.md)\<[]\>

***

### onStateChange

> `readonly` **onStateChange**: [`Event`](Event.md)\<[`"disconnected"` \| `"closed"` \| `"completed"` \| `"new"` \| `"connected"` \| `"failed"` \| `"checking"`]\>

***

### state

> **state**: `"disconnected"` \| `"closed"` \| `"completed"` \| `"new"` \| `"connected"` \| `"failed"` \| `"checking"` = `"new"`

## Accessors

### gatheringState

> `get` **gatheringState**(): `"complete"` \| `"new"` \| `"gathering"`

#### Returns

`"complete"` \| `"new"` \| `"gathering"`

***

### localCandidates

> `get` **localCandidates**(): [`IceCandidate`](IceCandidate.md)[]

#### Returns

[`IceCandidate`](IceCandidate.md)[]

***

### localParameters

> `get` **localParameters**(): [`RTCIceParameters`](RTCIceParameters.md)

#### Returns

[`RTCIceParameters`](RTCIceParameters.md)

***

### role

> `get` **role**(): `"controlling"` \| `"controlled"`

#### Returns

`"controlling"` \| `"controlled"`

## Methods

### addRemoteCandidate()

> **addRemoteCandidate**(`candidate`?): `undefined` \| `Promise`\<`void`\>

#### Parameters

• **candidate?**: [`IceCandidate`](IceCandidate.md)

#### Returns

`undefined` \| `Promise`\<`void`\>

***

### gather()

> **gather**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

***

### restart()

> **restart**(): `void`

#### Returns

`void`

***

### setRemoteParams()

> **setRemoteParams**(`remoteParameters`, `renomination`): `void`

#### Parameters

• **remoteParameters**: [`RTCIceParameters`](RTCIceParameters.md)

• **renomination**: `boolean` = `false`

#### Returns

`void`

***

### start()

> **start**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

***

### stop()

> **stop**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

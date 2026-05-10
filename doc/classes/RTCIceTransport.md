[**werift**](../README.md)

***

[werift](../globals.md) / RTCIceTransport

# Class: RTCIceTransport

+------------+
                                           |            |
                                           |disconnected|
                                           |            |
                                           +------------+
                                           ^           ^
                                           |           |
+------+      +----------+      +-----------+      +----------+
|      |      |          |      |           |      |          |
| new  | ---> | checking | ---> | connected | ---> | completed|
|      |      |          |      |           |      |          |
+------+      +----+-----+      +-----------+      +----------+
                   |           
                   |           
                   v           
               +-------+       
               |       |      
               | failed|      
               |       |      
               +-------+

## Constructors

### new RTCIceTransport()

> **new RTCIceTransport**(`iceGather`): [`RTCIceTransport`](RTCIceTransport.md)

#### Parameters

##### iceGather

[`RTCIceGatherer`](RTCIceGatherer.md)

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

> `readonly` **onIceCandidate**: [`Event`](Event.md)\<\[`undefined` \| [`IceCandidate`](IceCandidate.md)\]\>

***

### onNegotiationNeeded

> `readonly` **onNegotiationNeeded**: [`Event`](Event.md)\<\[\]\>

***

### onStateChange

> `readonly` **onStateChange**: [`Event`](Event.md)\<\[`"closed"` \| `"disconnected"` \| `"completed"` \| `"new"` \| `"connected"` \| `"failed"` \| `"checking"`\]\>

***

### state

> **state**: `"closed"` \| `"disconnected"` \| `"completed"` \| `"new"` \| `"connected"` \| `"failed"` \| `"checking"` = `"new"`

## Accessors

### gatheringState

#### Get Signature

> **get** **gatheringState**(): `"complete"` \| `"new"` \| `"gathering"`

##### Returns

`"complete"` \| `"new"` \| `"gathering"`

***

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

***

### role

#### Get Signature

> **get** **role**(): `"controlling"` \| `"controlled"`

##### Returns

`"controlling"` \| `"controlled"`

## Methods

### addRemoteCandidate()

> **addRemoteCandidate**(`candidate`?): `undefined` \| `Promise`\<`void`\>

#### Parameters

##### candidate?

[`IceCandidate`](IceCandidate.md)

#### Returns

`undefined` \| `Promise`\<`void`\>

***

### gather()

> **gather**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

***

### getStats()

> **getStats**(): `Promise`\<[`RTCStats`](../interfaces/RTCStats.md)[]\>

#### Returns

`Promise`\<[`RTCStats`](../interfaces/RTCStats.md)[]\>

***

### restart()

> **restart**(): `void`

#### Returns

`void`

***

### setRemoteParams()

> **setRemoteParams**(`remoteParameters`, `renomination`): `void`

#### Parameters

##### remoteParameters

[`RTCIceParameters`](RTCIceParameters.md)

##### renomination

`boolean` = `false`

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

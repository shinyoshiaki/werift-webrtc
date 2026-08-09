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

### component

> `readonly` **component**: `"rtp"` = `"rtp"`

***

### connection

> **connection**: [`IceConnection`](../interfaces/IceConnection.md)

***

### iceRestarts

> **iceRestarts**: `number` = `0`

***

### id

> `readonly` **id**: `string`

***

### ongatheringstatechange()?

> `optional` **ongatheringstatechange**: () => `void`

#### Returns

`void`

***

### onIceCandidate

> `readonly` **onIceCandidate**: [`Event`](Event.md)\<\[`undefined` \| [`IceCandidate`](IceCandidate.md)\]\>

***

### onNegotiationNeeded

> `readonly` **onNegotiationNeeded**: [`Event`](Event.md)\<\[\]\>

***

### onstatechange()?

> `optional` **onstatechange**: () => `void`

#### Returns

`void`

***

### onStateChange

> `readonly` **onStateChange**: [`Event`](Event.md)\<\[`"closed"` \| `"connected"` \| `"disconnected"` \| `"completed"` \| `"new"` \| `"failed"` \| `"checking"`\]\>

***

### state

> **state**: `"closed"` \| `"connected"` \| `"disconnected"` \| `"completed"` \| `"new"` \| `"failed"` \| `"checking"` = `"new"`

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

> **get** **role**(): `"unknown"` \| `"controlling"` \| `"controlled"`

##### Returns

`"unknown"` \| `"controlling"` \| `"controlled"`

## Methods

### addEventListener()

> **addEventListener**(`type`, `listener`, `options`?): `void`

#### Parameters

##### type

`string`

##### listener

(...`args`) => `void`

##### options?

`boolean` | \{ `once`: `boolean`; \}

#### Returns

`void`

***

### addRemoteCandidate()

> **addRemoteCandidate**(`candidate`?): `undefined` \| `Promise`\<`void`\>

#### Parameters

##### candidate?

[`IceCandidate`](IceCandidate.md)

#### Returns

`undefined` \| `Promise`\<`void`\>

***

### dispatchEvent()

> **dispatchEvent**(`event`): `boolean`

#### Parameters

##### event

`Event`

#### Returns

`boolean`

***

### gather()

> **gather**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

***

### getLocalCandidates()

> **getLocalCandidates**(): [`RTCIceCandidate`](RTCIceCandidate.md)[]

#### Returns

[`RTCIceCandidate`](RTCIceCandidate.md)[]

***

### getLocalParameters()

> **getLocalParameters**(): [`RTCIceParameters`](RTCIceParameters.md)

#### Returns

[`RTCIceParameters`](RTCIceParameters.md)

***

### getRemoteCandidates()

> **getRemoteCandidates**(): [`RTCIceCandidate`](RTCIceCandidate.md)[]

#### Returns

[`RTCIceCandidate`](RTCIceCandidate.md)[]

***

### getRemoteParameters()

> **getRemoteParameters**(): `null` \| [`RTCIceParameters`](RTCIceParameters.md)

#### Returns

`null` \| [`RTCIceParameters`](RTCIceParameters.md)

***

### getSelectedCandidatePair()

> **getSelectedCandidatePair**(): `null` \| \{ `local`: [`RTCIceCandidate`](RTCIceCandidate.md); `remote`: [`RTCIceCandidate`](RTCIceCandidate.md); \}

#### Returns

`null` \| \{ `local`: [`RTCIceCandidate`](RTCIceCandidate.md); `remote`: [`RTCIceCandidate`](RTCIceCandidate.md); \}

***

### getStats()

> **getStats**(`timestamp`, `transportId`): `Promise`\<[`RTCStats`](../interfaces/RTCStats.md)[]\>

#### Parameters

##### timestamp

`number` = `...`

##### transportId

`string` = `...`

#### Returns

`Promise`\<[`RTCStats`](../interfaces/RTCStats.md)[]\>

***

### removeEventListener()

> **removeEventListener**(`type`, `listener`): `void`

#### Parameters

##### type

`string`

##### listener

(...`args`) => `void`

#### Returns

`void`

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

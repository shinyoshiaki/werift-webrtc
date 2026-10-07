[**werift**](../README.md)

***

[werift](../globals.md) / RTCIceTransport

# Class: RTCIceTransport

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

> `readonly` **onStateChange**: [`Event`](Event.md)\<\[`"closed"` \| `"new"` \| `"connected"` \| `"disconnected"` \| `"completed"` \| `"failed"` \| `"checking"`\]\>

***

### state

> **state**: `"closed"` \| `"new"` \| `"connected"` \| `"disconnected"` \| `"completed"` \| `"failed"` \| `"checking"` = `"new"`

## Accessors

### gatheringState

#### Get Signature

> **get** **gatheringState**(): `"complete"` \| `"new"` \| `"gathering"`

##### Returns

`"complete"` \| `"new"` \| `"gathering"`

***

### hasStagedRestart

#### Get Signature

> **get** **hasStagedRestart**(): `boolean`

##### Returns

`boolean`

***

### localCandidates

#### Get Signature

> **get** **localCandidates**(): [`IceCandidate`](IceCandidate.md)[]

##### Returns

[`IceCandidate`](IceCandidate.md)[]

***

### localCandidatesComplete

#### Get Signature

> **get** **localCandidatesComplete**(): `boolean`

Whether the local description may carry `a=end-of-candidates`.

##### Returns

`boolean`

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

### addProvisionalRemoteCandidate()

> **addProvisionalRemoteCandidate**(`candidate`?): `undefined` \| `Promise`\<`void`\>

#### Parameters

##### candidate?

[`IceCandidate`](IceCandidate.md)

#### Returns

`undefined` \| `Promise`\<`void`\>

***

### addRemoteCandidate()

> **addRemoteCandidate**(`candidate`?): `undefined` \| `Promise`\<`void`\>

#### Parameters

##### candidate?

[`IceCandidate`](IceCandidate.md)

#### Returns

`undefined` \| `Promise`\<`void`\>

***

### commitLocalRestartIfStaged()

> **commitLocalRestartIfStaged**(): `Promise`\<`void`\>

Called unconditionally on every answer; actually restarts ICE only if
this transport has a staged local restart. No-op otherwise.

#### Returns

`Promise`\<`void`\>

***

### deferIceServers()

> **deferIceServers**(`options`): `void`

Keep ICE servers for the next gathering (an ICE restart).

#### Parameters

##### options

`Partial`\<[`IceOptions`](../interfaces/IceOptions.md)\>

#### Returns

`void`

***

### deliverProvisionalRemoteCandidate()

> **deliverProvisionalRemoteCandidate**(`candidate`?): `void`

`deliverRemoteCandidate` for the provisional (pranswer) generation.

#### Parameters

##### candidate?

[`IceCandidate`](IceCandidate.md)

#### Returns

`void`

***

### deliverRemoteCandidate()

> **deliverRemoteCandidate**(`candidate`?): `void`

Hand a remote candidate (`undefined`: end-of-candidates) to the ICE agent
without waiting for it. A host candidate is added synchronously; an mDNS
name may take seconds to resolve, and the agent itself orders that
resolution against end-of-candidates and generation changes, so the
description operation queue must not wait for it.

#### Parameters

##### candidate?

[`IceCandidate`](IceCandidate.md)

#### Returns

`void`

***

### discardUnappliedLocalRestart()

> **discardUnappliedLocalRestart**(): `void`

Drop only what an unapplied createOffer staged; keep the applied one.

#### Returns

`void`

***

### dispatchEvent()

> **dispatchEvent**(`event`): `boolean`

#### Parameters

##### event

`Event`

#### Returns

`boolean`

***

### emitCommittedCandidates()

> **emitCommittedCandidates**(): `void`

Signal the candidates an ICE restart committed by a local answer gathered.

#### Returns

`void`

***

### emitStagedCandidates()

> **emitStagedCandidates**(): `void`

#### Returns

`void`

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

### markLocalRestartApplied()

> **markLocalRestartApplied**(): `void`

The staged generation now belongs to an applied description.

#### Returns

`void`

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

> **restart**(`notifyNegotiation`, `applyNextGatherIceServers`): `void`

#### Parameters

##### notifyNegotiation

`boolean` = `true`

##### applyNextGatherIceServers

`boolean` = `true`

#### Returns

`void`

***

### rollbackLocalRestart()

> **rollbackLocalRestart**(): `void`

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

***

### setProvisionalRemoteParams()

> **setProvisionalRemoteParams**(`remoteParameters`): `void`

Feed a pranswer's ICE generation to the provisional checklist.

#### Parameters

##### remoteParameters

[`RTCIceParameters`](RTCIceParameters.md)

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

### stageLocalRestart()

> **stageLocalRestart**(): `void`

Prepare an ICE generation for SDP without touching the selected pair.

#### Returns

`void`

***

### start()

> **start**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

***

### startProvisionalChecks()

> **startProvisionalChecks**(): `void`

#### Returns

`void`

***

### stop()

> **stop**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

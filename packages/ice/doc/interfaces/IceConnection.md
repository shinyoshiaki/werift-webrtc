[**werift-ice**](../README.md) • **Docs**

***

[werift-ice](../globals.md) / IceConnection

# Interface: IceConnection

## Properties

### checkList

> **checkList**: [`CandidatePair`](../classes/CandidatePair.md)[]

***

### generation

> **generation**: `number`

***

### iceControlling

> **iceControlling**: `boolean`

***

### localCandidates

> **localCandidates**: [`Candidate`](../classes/Candidate.md)[]

***

### localCandidatesEnd

> **localCandidatesEnd**: `boolean`

***

### localPassword

> **localPassword**: `string`

***

### localUsername

> **localUsername**: `string`

***

### lookup?

> `optional` **lookup**: `MdnsLookup`

***

### nominated?

> `optional` **nominated**: [`CandidatePair`](../classes/CandidatePair.md)

***

### onData

> `readonly` **onData**: `Event`\<[`Buffer`]\>

***

### onIceCandidate

> `readonly` **onIceCandidate**: `Event`\<[[`Candidate`](../classes/Candidate.md)]\>

***

### options

> **options**: [`IceOptions`](IceOptions.md)

***

### remoteCandidatesEnd

> **remoteCandidatesEnd**: `boolean`

***

### remoteIsLite

> **remoteIsLite**: `boolean`

***

### remotePassword

> **remotePassword**: `string`

***

### remoteUsername

> **remoteUsername**: `string`

***

### state

> **state**: [`IceState`](../type-aliases/IceState.md)

***

### stateChanged

> `readonly` **stateChanged**: `Event`\<[[`IceState`](../type-aliases/IceState.md)]\>

***

### stunServer?

> `optional` **stunServer**: readonly [`string`, `number`]

***

### turnServer?

> `optional` **turnServer**: readonly [`string`, `number`]

## Methods

### addRemoteCandidate()

> **addRemoteCandidate**(`remoteCandidate`): `Promise`\<`void`\>

#### Parameters

• **remoteCandidate**: `undefined` \| [`Candidate`](../classes/Candidate.md)

#### Returns

`Promise`\<`void`\>

***

### close()

> **close**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

***

### connect()

> **connect**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

***

### gatherCandidates()

> **gatherCandidates**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

***

### getDefaultCandidate()

> **getDefaultCandidate**(): `undefined` \| [`Candidate`](../classes/Candidate.md)

#### Returns

`undefined` \| [`Candidate`](../classes/Candidate.md)

***

### resetNominatedPair()

> **resetNominatedPair**(): `void`

#### Returns

`void`

***

### restart()

> **restart**(): `void`

#### Returns

`void`

***

### send()

> **send**(`data`): `Promise`\<`void`\>

#### Parameters

• **data**: `Buffer`

#### Returns

`Promise`\<`void`\>

***

### setRemoteParams()

> **setRemoteParams**(`params`): `void`

#### Parameters

• **params**

• **params.iceLite**: `boolean`

• **params.password**: `string`

• **params.usernameFragment**: `string`

#### Returns

`void`

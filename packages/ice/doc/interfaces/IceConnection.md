[**werift-ice**](../README.md)

***

[werift-ice](../globals.md) / IceConnection

# Interface: IceConnection

## Properties

### candidatePairs

> **candidatePairs**: [`CandidatePair`](../classes/CandidatePair.md)[]

***

### checkList

> **checkList**: [`CandidatePair`](../classes/CandidatePair.md)[]

***

### gathersFromServers?

> `readonly` `optional` **gathersFromServers**: `boolean`

Whether gathering contacts a STUN or TURN server.

***

### generation

> **generation**: `number`

***

### iceControlling

> **iceControlling**: `boolean`

***

### iceLite

> **iceLite**: `boolean`

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

> `readonly` **onData**: `Event`\<\[`Buffer`\<`ArrayBufferLike`\>\]\>

***

### onIceCandidate

> `readonly` **onIceCandidate**: `Event`\<\[[`Candidate`](../classes/Candidate.md)\]\>

***

### options

> **options**: [`IceOptions`](IceOptions.md)

***

### provisionalNominated?

> `readonly` `optional` **provisionalNominated**: [`CandidatePair`](../classes/CandidatePair.md)

***

### remoteCandidates

> **remoteCandidates**: [`Candidate`](../classes/Candidate.md)[]

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

> `readonly` **stateChanged**: `Event`\<\[[`IceState`](../type-aliases/IceState.md)\]\>

***

### stunServer?

> `optional` **stunServer**: readonly \[`string`, `number`\]

***

### turnServer?

> `optional` **turnServer**: readonly \[`string`, `number`\]

## Methods

### addProvisionalRemoteCandidate()?

> `optional` **addProvisionalRemoteCandidate**(`candidate`): `Promise`\<`void`\>

#### Parameters

##### candidate

`undefined` | [`Candidate`](../classes/Candidate.md)

#### Returns

`Promise`\<`void`\>

***

### addRemoteCandidate()

> **addRemoteCandidate**(`remoteCandidate`): `Promise`\<`void`\>

#### Parameters

##### remoteCandidate

`undefined` | [`Candidate`](../classes/Candidate.md)

#### Returns

`Promise`\<`void`\>

***

### close()

> **close**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

***

### commitLocalCredentials()?

> `optional` **commitLocalCredentials**(`usernameFragment`, `password`): `void`

#### Parameters

##### usernameFragment

`string`

##### password

`string`

#### Returns

`void`

***

### connect()

> **connect**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

***

### discardStagedLocalCredentials()?

> `optional` **discardStagedLocalCredentials**(`usernameFragment`): `void`

#### Parameters

##### usernameFragment

`string`

#### Returns

`void`

***

### gatherCandidates()

> **gatherCandidates**(): `Promise`\<`void`\>

Gather the current generation's candidates. After an ICE restart the
candidates the kept sockets advertised are re-advertised synchronously;
only server work (STUN, TURN) is awaited.

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

### restartRemote()?

> `optional` **restartRemote**(): `void`

The remote side alone restarted (new remote credentials in an answer):
drop the remote generation and its checks, keep the local credentials
and gathered candidates.

#### Returns

`void`

***

### send()

> **send**(`data`): `Promise`\<`void`\>

#### Parameters

##### data

`Buffer`

#### Returns

`Promise`\<`void`\>

***

### setIceServers()

> **setIceServers**(`options`): `void`

#### Parameters

##### options

`Partial`\<[`IceOptions`](IceOptions.md)\>

#### Returns

`void`

***

### setProvisionalRemoteParams()?

> `optional` **setProvisionalRemoteParams**(`params`): `void`

#### Parameters

##### params

###### password

`string`

###### usernameFragment

`string`

#### Returns

`void`

***

### setRemoteParams()

> **setRemoteParams**(`params`): `void`

#### Parameters

##### params

###### iceLite

`boolean`

###### password

`string`

###### usernameFragment

`string`

#### Returns

`void`

***

### stageLocalCredentials()?

> `optional` **stageLocalCredentials**(`usernameFragment`, `password`): `void`

Optional staged-restart and provisional-generation support. An
implementation without them still restarts ICE at the final answer, but
cannot answer or run checks for the new generation during pranswer.

#### Parameters

##### usernameFragment

`string`

##### password

`string`

#### Returns

`void`

***

### startProvisionalChecks()?

> `optional` **startProvisionalChecks**(): `void`

#### Returns

`void`

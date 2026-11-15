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

> `readonly` `optional` **gathersFromServers?**: `boolean`

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

> `optional` **lookup?**: `MdnsLookup`

***

### nominated?

> `optional` **nominated?**: [`CandidatePair`](../classes/CandidatePair.md)

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

> `readonly` `optional` **provisionalNominated?**: [`CandidatePair`](../classes/CandidatePair.md)

***

### remoteCandidates

> **remoteCandidates**: [`Candidate`](../classes/Candidate.md)[]

***

### remoteCandidatesEnd

> **remoteCandidatesEnd**: `boolean`

***

### remoteIce2?

> `readonly` `optional` **remoteIce2?**: `boolean`

The remote declared `ice2`: an RFC 8445 agent (RFC 8445 §10).

***

### remoteIceOptions?

> `optional` **remoteIceOptions?**: `string`[]

The remote `a=ice-options` tokens (RFC 8839 §5.6), e.g. `trickle`,
`ice2`. Informational: werift already follows RFC 8445, so no token
changes how checks or nomination run.

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

### ~~stunServer?~~

> `optional` **stunServer?**: readonly \[`string`, `number`\]

#### Deprecated

The first of [IceConnection.stunServers](#stunservers).

***

### stunServers?

> `optional` **stunServers?**: (readonly \[`string`, `number`\])[]

STUN servers gathering queries, normalized from the options (see
[normalizeIceServerOptions](../functions/normalizeIceServerOptions.md)). Optional so that other
implementations of this interface keep compiling.

***

### ~~turnServer?~~

> `optional` **turnServer?**: readonly \[`string`, `number`\]

#### Deprecated

The address of the first of [IceConnection.turnServers](#turnservers).

***

### turnServers?

> `optional` **turnServers?**: [`TurnServerOptions`](../type-aliases/TurnServerOptions.md)[]

TURN servers gathering allocates on, each with its own credential.

## Methods

### addProvisionalRemoteCandidate()?

> `optional` **addProvisionalRemoteCandidate**(`candidate`): `Promise`\<`void`\>

#### Parameters

##### candidate

[`Candidate`](../classes/Candidate.md) \| `undefined`

#### Returns

`Promise`\<`void`\>

***

### addRemoteCandidate()

> **addRemoteCandidate**(`remoteCandidate`): `Promise`\<`void`\>

#### Parameters

##### remoteCandidate

[`Candidate`](../classes/Candidate.md) \| `undefined`

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

### dropOtherRemoteGenerations()?

> `optional` **dropOtherRemoteGenerations**(`usernameFragment`): `void`

Drop remote candidates and pairs that name another remote ufrag.

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

> **getDefaultCandidate**(): [`Candidate`](../classes/Candidate.md) \| `undefined`

#### Returns

[`Candidate`](../classes/Candidate.md) \| `undefined`

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

### setRemoteIceOptions()?

> `optional` **setRemoteIceOptions**(`options`): `void`

Record the remote `a=ice-options` tokens (see remoteIceOptions).

#### Parameters

##### options

`string`[]

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

> `optional` **stageLocalCredentials**(`usernameFragment`, `password`, `gatherOptions?`): `void`

`gatherOptions`: the options the staged generation gathers with (an ICE
server update applied at the commit); its provisional checks use only
the sockets those options allow. Defaults to the current options.

#### Parameters

##### usernameFragment

`string`

##### password

`string`

##### gatherOptions?

`Partial`\<[`IceOptions`](IceOptions.md)\>

#### Returns

`void`

***

### startProvisionalChecks()?

> `optional` **startProvisionalChecks**(): `void`

#### Returns

`void`

***

### waitForLocalCandidatesEnd()?

> `optional` **waitForLocalCandidatesEnd**(): `Promise`\<`void`\>

Resolves when `localCandidatesEnd` becomes true after `gatherCandidates()`
returned (server-reflexive queries that continue in the background), or
when the generation ends. Optional so that other implementations of this
interface keep compiling; without it gathering ends when
`gatherCandidates()` returns.

#### Returns

`Promise`\<`void`\>

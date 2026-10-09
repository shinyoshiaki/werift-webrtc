[**werift**](../README.md)

***

[werift](../globals.md) / Connection

# Class: Connection

## Implements

- [`IceConnection`](../interfaces/IceConnection.md)

## Constructors

### new Connection()

> **new Connection**(`_iceControlling`, `options`?): [`Connection`](Connection.md)

#### Parameters

##### \_iceControlling

`boolean`

##### options?

`Partial`\<[`IceOptions`](../interfaces/IceOptions.md)\>

#### Returns

[`Connection`](Connection.md)

## Properties

### checkList

> **checkList**: [`CandidatePair`](CandidatePair.md)[] = `[]`

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`checkList`](../interfaces/IceConnection.md#checklist)

***

### generation

> **generation**: `number` = `-1`

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`generation`](../interfaces/IceConnection.md#generation)

***

### localCandidates

> **localCandidates**: [`Candidate`](Candidate.md)[] = `[]`

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`localCandidates`](../interfaces/IceConnection.md#localcandidates)

***

### localCandidatesEnd

> **localCandidatesEnd**: `boolean` = `false`

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`localCandidatesEnd`](../interfaces/IceConnection.md#localcandidatesend)

***

### localPassword

> **localPassword**: `string`

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`localPassword`](../interfaces/IceConnection.md#localpassword)

***

### localUsername

> **localUsername**: `string`

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`localUsername`](../interfaces/IceConnection.md#localusername)

***

### lookup?

> `optional` **lookup**: `MdnsLookup`

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`lookup`](../interfaces/IceConnection.md#lookup)

***

### nominated?

> `optional` **nominated**: [`CandidatePair`](CandidatePair.md)

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`nominated`](../interfaces/IceConnection.md#nominated)

***

### onData

> `readonly` **onData**: [`Event`](Event.md)\<\[`Buffer`\<`ArrayBufferLike`\>\]\>

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`onData`](../interfaces/IceConnection.md#ondata)

***

### onIceCandidate

> `readonly` **onIceCandidate**: [`Event`](Event.md)\<\[[`Candidate`](Candidate.md)\]\>

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`onIceCandidate`](../interfaces/IceConnection.md#onicecandidate)

***

### options

> **options**: [`IceOptions`](../interfaces/IceOptions.md)

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`options`](../interfaces/IceConnection.md#options)

***

### remoteCandidatesEnd

> **remoteCandidatesEnd**: `boolean` = `false`

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`remoteCandidatesEnd`](../interfaces/IceConnection.md#remotecandidatesend)

***

### remoteIsLite

> **remoteIsLite**: `boolean` = `false`

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`remoteIsLite`](../interfaces/IceConnection.md#remoteislite)

***

### remotePassword

> **remotePassword**: `string` = `""`

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`remotePassword`](../interfaces/IceConnection.md#remotepassword)

***

### remoteUsername

> **remoteUsername**: `string` = `""`

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`remoteUsername`](../interfaces/IceConnection.md#remoteusername)

***

### state

> **state**: [`IceState`](../type-aliases/IceState.md) = `"new"`

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`state`](../interfaces/IceConnection.md#state)

***

### stateChanged

> `readonly` **stateChanged**: [`Event`](Event.md)\<\[[`IceState`](../type-aliases/IceState.md)\]\>

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`stateChanged`](../interfaces/IceConnection.md#statechanged)

***

### stunServer?

> `optional` **stunServer**: readonly \[`string`, `number`\]

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`stunServer`](../interfaces/IceConnection.md#stunserver)

***

### turnServer?

> `optional` **turnServer**: readonly \[`string`, `number`\]

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`turnServer`](../interfaces/IceConnection.md#turnserver)

***

### userHistory

> **userHistory**: `object` = `{}`

#### Index Signature

\[`username`: `string`\]: `string`

## Accessors

### candidatePairs

#### Get Signature

> **get** **candidatePairs**(): [`CandidatePair`](CandidatePair.md)[]

##### Returns

[`CandidatePair`](CandidatePair.md)[]

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`candidatePairs`](../interfaces/IceConnection.md#candidatepairs)

***

### gathersFromServers

#### Get Signature

> **get** **gathersFromServers**(): `boolean`

Whether gathering contacts a STUN or TURN server (more than re-advertising sockets).

##### Returns

`boolean`

Whether gathering contacts a STUN or TURN server.

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`gathersFromServers`](../interfaces/IceConnection.md#gathersfromservers)

***

### iceControlling

#### Get Signature

> **get** **iceControlling**(): `boolean`

##### Returns

`boolean`

#### Set Signature

> **set** **iceControlling**(`value`): `void`

##### Parameters

###### value

`boolean`

##### Returns

`void`

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`iceControlling`](../interfaces/IceConnection.md#icecontrolling)

***

### iceLite

#### Get Signature

> **get** **iceLite**(): `boolean`

##### Returns

`boolean`

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`iceLite`](../interfaces/IceConnection.md#icelite)

***

### provisionalNominated

#### Get Signature

> **get** **provisionalNominated**(): `undefined` \| [`CandidatePair`](CandidatePair.md)

##### Returns

`undefined` \| [`CandidatePair`](CandidatePair.md)

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`provisionalNominated`](../interfaces/IceConnection.md#provisionalnominated)

***

### remoteCandidates

#### Get Signature

> **get** **remoteCandidates**(): [`Candidate`](Candidate.md)[]

##### Returns

[`Candidate`](Candidate.md)[]

#### Set Signature

> **set** **remoteCandidates**(`value`): `void`

##### Parameters

###### value

[`Candidate`](Candidate.md)[]

##### Returns

`void`

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`remoteCandidates`](../interfaces/IceConnection.md#remotecandidates)

## Methods

### addProvisionalRemoteCandidate()

> **addProvisionalRemoteCandidate**(`remoteCandidate`): `Promise`\<`void`\>

#### Parameters

##### remoteCandidate

`undefined` | [`Candidate`](Candidate.md)

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`addProvisionalRemoteCandidate`](../interfaces/IceConnection.md#addprovisionalremotecandidate)

***

### addRemoteCandidate()

> **addRemoteCandidate**(`remoteCandidate`): `Promise`\<`void`\>

#### Parameters

##### remoteCandidate

`undefined` | [`Candidate`](Candidate.md)

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`addRemoteCandidate`](../interfaces/IceConnection.md#addremotecandidate)

***

### checkIncoming()

> **checkIncoming**(`message`, `addr`, `protocol`): `void`

#### Parameters

##### message

[`Message`](Message.md)

##### addr

readonly \[`string`, `number`\]

##### protocol

[`Protocol`](../interfaces/Protocol.md)

#### Returns

`void`

***

### checkStart()

> **checkStart**(`pair`): `object`

#### Parameters

##### pair

[`CandidatePair`](CandidatePair.md)

#### Returns

`object`

##### awaitable

> **awaitable**: `Promise`\<`void`\> = `p`

##### reject()

> **reject**: (`reason`?) => `void`

###### Parameters

###### reason?

`any`

###### Returns

`void`

##### resolve()

> **resolve**: (`value`) => `void`

###### Parameters

###### value

`void` | `PromiseLike`\<`void`\>

###### Returns

`void`

***

### close()

> **close**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`close`](../interfaces/IceConnection.md#close)

***

### commitLocalCredentials()

> **commitLocalCredentials**(`usernameFragment`, `password`): `void`

Called after restart, before re-gathering the chosen generation.

#### Parameters

##### usernameFragment

`string`

##### password

`string`

#### Returns

`void`

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`commitLocalCredentials`](../interfaces/IceConnection.md#commitlocalcredentials)

***

### connect()

> **connect**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`connect`](../interfaces/IceConnection.md#connect)

***

### discardStagedLocalCredentials()

> **discardStagedLocalCredentials**(`usernameFragment`): `void`

#### Parameters

##### usernameFragment

`string`

#### Returns

`void`

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`discardStagedLocalCredentials`](../interfaces/IceConnection.md#discardstagedlocalcredentials)

***

### gatherCandidates()

> **gatherCandidates**(): `Promise`\<`void`\>

Gather the local candidates of the current generation.

After an ICE restart everything the kept sockets already advertised is
advertised again synchronously, before this method first awaits: the host
candidates and the server-reflexive address each kept socket had. Only
work that needs a server follows (a fresh STUN query, a new TURN
allocation), so a caller may let it finish in the background.

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`gatherCandidates`](../interfaces/IceConnection.md#gathercandidates)

***

### getDefaultCandidate()

> **getDefaultCandidate**(): [`Candidate`](Candidate.md)

#### Returns

[`Candidate`](Candidate.md)

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`getDefaultCandidate`](../interfaces/IceConnection.md#getdefaultcandidate)

***

### resetNominatedPair()

> **resetNominatedPair**(): `void`

#### Returns

`void`

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`resetNominatedPair`](../interfaces/IceConnection.md#resetnominatedpair)

***

### restart()

> **restart**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`restart`](../interfaces/IceConnection.md#restart)

***

### restartRemote()

> **restartRemote**(): `void`

Only the remote side restarted (new remote credentials in an answer to an
offer that kept the local ones): the remote generation, its checks and
the selected pair start over; local credentials and candidates stay.

#### Returns

`void`

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`restartRemote`](../interfaces/IceConnection.md#restartremote)

***

### send()

> **send**(`data`): `Promise`\<`void`\>

#### Parameters

##### data

`Buffer`

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`send`](../interfaces/IceConnection.md#send)

***

### setIceServers()

> **setIceServers**(`options`): `void`

Replace STUN/TURN servers after construction.
Server-related fields are replaced (not partial-merged) so that removing
TURN clears residual credentials. W3C setConfiguration replaces the ICE
server list rather than merging additively.

Used when servers are learned after the gatherer was built (e.g. WHIP
Link headers) and must take effect before the next gather pass.

#### Parameters

##### options

`Partial`\<[`IceOptions`](../interfaces/IceOptions.md)\>

#### Returns

`void`

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`setIceServers`](../interfaces/IceConnection.md#seticeservers)

***

### setProvisionalRemoteParams()

> **setProvisionalRemoteParams**(`__namedParameters`): `void`

Remote credentials of the provisional generation (pranswer).

#### Parameters

##### \_\_namedParameters

###### password

`string`

###### usernameFragment

`string`

#### Returns

`void`

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`setProvisionalRemoteParams`](../interfaces/IceConnection.md#setprovisionalremoteparams)

***

### setRemoteParams()

> **setRemoteParams**(`__namedParameters`): `void`

#### Parameters

##### \_\_namedParameters

###### iceLite

`boolean`

###### password

`string`

###### usernameFragment

`string`

#### Returns

`void`

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`setRemoteParams`](../interfaces/IceConnection.md#setremoteparams)

***

### stageLocalCredentials()

> **stageLocalCredentials**(`usernameFragment`, `password`): `void`

Accept provisional checks without changing the selected current pair.

#### Parameters

##### usernameFragment

`string`

##### password

`string`

#### Returns

`void`

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`stageLocalCredentials`](../interfaces/IceConnection.md#stagelocalcredentials)

***

### startProvisionalChecks()

> **startProvisionalChecks**(): `void`

Start checks for the provisional generation; the selected pair is kept.

#### Returns

`void`

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`startProvisionalChecks`](../interfaces/IceConnection.md#startprovisionalchecks)

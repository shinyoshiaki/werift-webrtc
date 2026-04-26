[**werift**](../README.md) • **Docs**

***

[werift](../globals.md) / Connection

# Class: Connection

## Implements

- [`IceConnection`](../interfaces/IceConnection.md)

## Constructors

### new Connection()

> **new Connection**(`_iceControlling`, `options`?): [`Connection`](Connection.md)

#### Parameters

• **\_iceControlling**: `boolean`

• **options?**: `Partial`\<[`IceOptions`](../interfaces/IceOptions.md)\>

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

> `readonly` **onData**: [`Event`](Event.md)\<[`Buffer`]\>

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`onData`](../interfaces/IceConnection.md#ondata)

***

### onIceCandidate

> `readonly` **onIceCandidate**: [`Event`](Event.md)\<[[`Candidate`](Candidate.md)]\>

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

> `readonly` **stateChanged**: [`Event`](Event.md)\<[[`IceState`](../type-aliases/IceState.md)]\>

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`stateChanged`](../interfaces/IceConnection.md#statechanged)

***

### stunServer?

> `optional` **stunServer**: readonly [`string`, `number`]

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`stunServer`](../interfaces/IceConnection.md#stunserver)

***

### turnServer?

> `optional` **turnServer**: readonly [`string`, `number`]

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`turnServer`](../interfaces/IceConnection.md#turnserver)

***

### userHistory

> **userHistory**: `object` = `{}`

#### Index Signature

 \[`username`: `string`\]: `string`

## Accessors

### iceControlling

> `get` **iceControlling**(): `boolean`

> `set` **iceControlling**(`value`): `void`

#### Parameters

• **value**: `boolean`

#### Returns

`boolean`

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`iceControlling`](../interfaces/IceConnection.md#icecontrolling)

***

### remoteCandidates

> `get` **remoteCandidates**(): [`Candidate`](Candidate.md)[]

> `set` **remoteCandidates**(`value`): `void`

#### Parameters

• **value**: [`Candidate`](Candidate.md)[]

#### Returns

[`Candidate`](Candidate.md)[]

## Methods

### addRemoteCandidate()

> **addRemoteCandidate**(`remoteCandidate`): `Promise`\<`void`\>

#### Parameters

• **remoteCandidate**: `undefined` \| [`Candidate`](Candidate.md)

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`addRemoteCandidate`](../interfaces/IceConnection.md#addremotecandidate)

***

### checkIncoming()

> **checkIncoming**(`message`, `addr`, `protocol`): `void`

#### Parameters

• **message**: [`Message`](Message.md)

• **addr**: readonly [`string`, `number`]

• **protocol**: [`Protocol`](../interfaces/Protocol.md)

#### Returns

`void`

***

### checkStart()

> **checkStart**(`pair`): `object`

#### Parameters

• **pair**: [`CandidatePair`](CandidatePair.md)

#### Returns

`object`

##### awaitable

> **awaitable**: `Promise`\<`void`\> = `p`

##### reject()

> **reject**: (`reason`?) => `void`

###### Parameters

• **reason?**: `any`

###### Returns

`void`

##### resolve()

> **resolve**: (`value`) => `void`

###### Parameters

• **value**: `void` \| `PromiseLike`\<`void`\>

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

### connect()

> **connect**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`connect`](../interfaces/IceConnection.md#connect)

***

### gatherCandidates()

> **gatherCandidates**(): `Promise`\<`void`\>

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

### send()

> **send**(`data`): `Promise`\<`void`\>

#### Parameters

• **data**: `Buffer`

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`send`](../interfaces/IceConnection.md#send)

***

### setRemoteParams()

> **setRemoteParams**(`__namedParameters`): `void`

#### Parameters

• **\_\_namedParameters**

• **\_\_namedParameters.iceLite**: `boolean`

• **\_\_namedParameters.password**: `string`

• **\_\_namedParameters.usernameFragment**: `string`

#### Returns

`void`

#### Implementation of

[`IceConnection`](../interfaces/IceConnection.md).[`setRemoteParams`](../interfaces/IceConnection.md#setremoteparams)

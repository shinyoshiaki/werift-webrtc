[werift](../README.md) / [Exports](../modules.md) / Connection

# Class: Connection

## Table of contents

### Constructors

- [constructor](Connection.md#constructor)

### Properties

- [\_components](Connection.md#_components)
- [\_localCandidatesEnd](Connection.md#_localcandidatesend)
- [\_tieBreaker](Connection.md#_tiebreaker)
- [checkList](Connection.md#checklist)
- [dnsLookup](Connection.md#dnslookup)
- [iceControlling](Connection.md#icecontrolling)
- [localCandidates](Connection.md#localcandidates)
- [localPassword](Connection.md#localpassword)
- [localUserName](Connection.md#localusername)
- [onData](Connection.md#ondata)
- [options](Connection.md#options)
- [remoteCandidatesEnd](Connection.md#remotecandidatesend)
- [remoteIsLite](Connection.md#remoteislite)
- [remotePassword](Connection.md#remotepassword)
- [remoteUsername](Connection.md#remoteusername)
- [state](Connection.md#state)
- [stateChanged](Connection.md#statechanged)
- [stunServer](Connection.md#stunserver)
- [turnServer](Connection.md#turnserver)
- [useIpv4](Connection.md#useipv4)
- [useIpv6](Connection.md#useipv6)

### Accessors

- [nominatedKeys](Connection.md#nominatedkeys)
- [remoteAddr](Connection.md#remoteaddr)
- [remoteCandidates](Connection.md#remotecandidates)

### Methods

- [addRemoteCandidate](Connection.md#addremotecandidate)
- [checkIncoming](Connection.md#checkincoming)
- [checkStart](Connection.md#checkstart)
- [close](Connection.md#close)
- [connect](Connection.md#connect)
- [dataReceived](Connection.md#datareceived)
- [gatherCandidates](Connection.md#gathercandidates)
- [getDefaultCandidate](Connection.md#getdefaultcandidate)
- [requestReceived](Connection.md#requestreceived)
- [send](Connection.md#send)

## Constructors

### constructor

• **new Connection**(`iceControlling`, `options?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `iceControlling` | `boolean` |
| `options?` | `Partial`<[`IceOptions`](../interfaces/IceOptions.md)\> |

## Properties

### \_components

• **\_components**: `Set`<`number`\>

___

### \_localCandidatesEnd

• **\_localCandidatesEnd**: `boolean` = `false`

___

### \_tieBreaker

• **\_tieBreaker**: `BigInt`

___

### checkList

• **checkList**: `CandidatePair`[] = `[]`

___

### dnsLookup

• `Optional` **dnsLookup**: `DnsLookup`

___

### iceControlling

• **iceControlling**: `boolean`

___

### localCandidates

• **localCandidates**: [`Candidate`](Candidate.md)[] = `[]`

___

### localPassword

• **localPassword**: `string`

___

### localUserName

• **localUserName**: `string`

___

### onData

• `Readonly` **onData**: `default`<[`Buffer`, `number`]\>

___

### options

• **options**: [`IceOptions`](../interfaces/IceOptions.md)

___

### remoteCandidatesEnd

• **remoteCandidatesEnd**: `boolean` = `false`

___

### remoteIsLite

• **remoteIsLite**: `boolean` = `false`

___

### remotePassword

• **remotePassword**: `string` = `""`

___

### remoteUsername

• **remoteUsername**: `string` = `""`

___

### state

• **state**: `IceState` = `"new"`

___

### stateChanged

• `Readonly` **stateChanged**: `default`<[`IceState`]\>

___

### stunServer

• `Optional` **stunServer**: readonly [`string`, `number`]

___

### turnServer

• `Optional` **turnServer**: readonly [`string`, `number`]

___

### useIpv4

• **useIpv4**: `boolean`

___

### useIpv6

• **useIpv6**: `boolean`

## Accessors

### nominatedKeys

• `get` **nominatedKeys**(): `string`[]

#### Returns

`string`[]

___

### remoteAddr

• `get` **remoteAddr**(): readonly [`string`, `number`]

#### Returns

readonly [`string`, `number`]

___

### remoteCandidates

• `get` **remoteCandidates**(): [`Candidate`](Candidate.md)[]

#### Returns

[`Candidate`](Candidate.md)[]

• `set` **remoteCandidates**(`value`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `value` | [`Candidate`](Candidate.md)[] |

#### Returns

`void`

## Methods

### addRemoteCandidate

▸ **addRemoteCandidate**(`remoteCandidate`): `Promise`<`void`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `remoteCandidate` | `undefined` \| [`Candidate`](Candidate.md) |

#### Returns

`Promise`<`void`\>

___

### checkIncoming

▸ **checkIncoming**(`message`, `addr`, `protocol`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `message` | `Message` |
| `addr` | readonly [`string`, `number`] |
| `protocol` | `Protocol` |

#### Returns

`void`

___

### checkStart

▸ **checkStart**(`pair`): `PCancelable`<`unknown`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `pair` | `CandidatePair` |

#### Returns

`PCancelable`<`unknown`\>

___

### close

▸ **close**(): `Promise`<`void`\>

#### Returns

`Promise`<`void`\>

___

### connect

▸ **connect**(): `Promise`<`void`\>

#### Returns

`Promise`<`void`\>

___

### dataReceived

▸ **dataReceived**(`data`, `component`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |
| `component` | `number` |

#### Returns

`void`

___

### gatherCandidates

▸ **gatherCandidates**(`cb?`): `Promise`<`void`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `cb?` | (`candidate`: [`Candidate`](Candidate.md)) => `void` |

#### Returns

`Promise`<`void`\>

___

### getDefaultCandidate

▸ **getDefaultCandidate**(`component`): `undefined` \| [`Candidate`](Candidate.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `component` | `number` |

#### Returns

`undefined` \| [`Candidate`](Candidate.md)

___

### requestReceived

▸ **requestReceived**(`message`, `addr`, `protocol`, `rawData`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `message` | `Message` |
| `addr` | readonly [`string`, `number`] |
| `protocol` | `Protocol` |
| `rawData` | `Buffer` |

#### Returns

`void`

___

### send

▸ **send**(`data`): `Promise`<`void`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |

#### Returns

`Promise`<`void`\>

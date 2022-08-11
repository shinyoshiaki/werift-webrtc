[werift](../README.md) / [Exports](../modules.md) / Connection

# Class: Connection

## Table of contents

### Constructors

- [constructor](Connection.md#constructor)

### Properties

- [\_components](Connection.md#_components)
- [\_localCandidatesEnd](Connection.md#_localcandidatesend)
- [\_remoteCandidates](Connection.md#_remotecandidates)
- [\_tieBreaker](Connection.md#_tiebreaker)
- [checkList](Connection.md#checklist)
- [checkListDone](Connection.md#checklistdone)
- [checkListState](Connection.md#checkliststate)
- [dnsLookup](Connection.md#dnslookup)
- [earlyChecks](Connection.md#earlychecks)
- [iceControlling](Connection.md#icecontrolling)
- [localCandidates](Connection.md#localcandidates)
- [localCandidatesStart](Connection.md#localcandidatesstart)
- [localPassword](Connection.md#localpassword)
- [localUserName](Connection.md#localusername)
- [nominated](Connection.md#nominated)
- [nominating](Connection.md#nominating)
- [onData](Connection.md#ondata)
- [options](Connection.md#options)
- [promiseGatherCandidates](Connection.md#promisegathercandidates)
- [protocols](Connection.md#protocols)
- [queryConsentHandle](Connection.md#queryconsenthandle)
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
- [buildRequest](Connection.md#buildrequest)
- [checkComplete](Connection.md#checkcomplete)
- [checkIncoming](Connection.md#checkincoming)
- [checkStart](Connection.md#checkstart)
- [checkState](Connection.md#checkstate)
- [close](Connection.md#close)
- [connect](Connection.md#connect)
- [dataReceived](Connection.md#datareceived)
- [findPair](Connection.md#findpair)
- [gatherCandidates](Connection.md#gathercandidates)
- [getComponentCandidates](Connection.md#getcomponentcandidates)
- [getDefaultCandidate](Connection.md#getdefaultcandidate)
- [pairRemoteCandidate](Connection.md#pairremotecandidate)
- [pruneComponents](Connection.md#prunecomponents)
- [queryConsent](Connection.md#queryconsent)
- [requestReceived](Connection.md#requestreceived)
- [respondError](Connection.md#responderror)
- [schedulingChecks](Connection.md#schedulingchecks)
- [send](Connection.md#send)
- [sendTo](Connection.md#sendto)
- [setState](Connection.md#setstate)
- [sortCheckList](Connection.md#sortchecklist)
- [switchRole](Connection.md#switchrole)
- [unfreezeInitial](Connection.md#unfreezeinitial)

## Constructors

### constructor

• **new Connection**(`iceControlling`, `options?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `iceControlling` | `boolean` |
| `options?` | `Partial`<[`IceOptions`](../interfaces/IceOptions.md)\> |

#### Defined in

[packages/ice/src/ice.ts:67](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L67)

## Properties

### \_components

• **\_components**: `Set`<`number`\>

#### Defined in

[packages/ice/src/ice.ts:40](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L40)

___

### \_localCandidatesEnd

• **\_localCandidatesEnd**: `boolean` = `false`

#### Defined in

[packages/ice/src/ice.ts:41](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L41)

___

### \_remoteCandidates

• `Private` **\_remoteCandidates**: [`Candidate`](Candidate.md)[] = `[]`

#### Defined in

[packages/ice/src/ice.ts:49](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L49)

___

### \_tieBreaker

• **\_tieBreaker**: `BigInt`

#### Defined in

[packages/ice/src/ice.ts:42](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L42)

___

### checkList

• **checkList**: `CandidatePair`[] = `[]`

#### Defined in

[packages/ice/src/ice.ts:32](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L32)

___

### checkListDone

• `Private` **checkListDone**: `boolean` = `false`

#### Defined in

[packages/ice/src/ice.ts:59](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L59)

___

### checkListState

• `Private` **checkListState**: `PQueue`<`number`\>

#### Defined in

[packages/ice/src/ice.ts:60](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L60)

___

### dnsLookup

• `Optional` **dnsLookup**: `DnsLookup`

#### Defined in

[packages/ice/src/ice.ts:44](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L44)

___

### earlyChecks

• `Private` **earlyChecks**: [`Message`, readonly [`string`, `number`], `Protocol`][] = `[]`

#### Defined in

[packages/ice/src/ice.ts:61](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L61)

___

### iceControlling

• **iceControlling**: `boolean`

#### Defined in

[packages/ice/src/ice.ts:67](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L67)

___

### localCandidates

• **localCandidates**: [`Candidate`](Candidate.md)[] = `[]`

#### Defined in

[packages/ice/src/ice.ts:33](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L33)

___

### localCandidatesStart

• `Private` **localCandidatesStart**: `boolean` = `false`

#### Defined in

[packages/ice/src/ice.ts:62](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L62)

___

### localPassword

• **localPassword**: `string`

#### Defined in

[packages/ice/src/ice.ts:28](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L28)

___

### localUserName

• **localUserName**: `string`

#### Defined in

[packages/ice/src/ice.ts:27](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L27)

___

### nominated

• `Private` **nominated**: `Object` = `{}`

#### Index signature

▪ [key: `number`]: `CandidatePair`

#### Defined in

[packages/ice/src/ice.ts:51](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L51)

___

### nominating

• `Private` **nominating**: `Set`<`number`\>

#### Defined in

[packages/ice/src/ice.ts:55](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L55)

___

### onData

• `Readonly` **onData**: `default`<[`Buffer`, `number`]\>

#### Defined in

[packages/ice/src/ice.ts:46](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L46)

___

### options

• **options**: [`IceOptions`](../interfaces/IceOptions.md)

#### Defined in

[packages/ice/src/ice.ts:38](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L38)

___

### promiseGatherCandidates

• `Private` `Optional` **promiseGatherCandidates**: `default`<[]\>

#### Defined in

[packages/ice/src/ice.ts:65](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L65)

___

### protocols

• `Private` **protocols**: `Protocol`[] = `[]`

#### Defined in

[packages/ice/src/ice.ts:63](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L63)

___

### queryConsentHandle

• `Private` `Optional` **queryConsentHandle**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `cancel` | () => `void` |
| `done` | () => `boolean` |
| `promise` | `PCancelable`<`any`\> |

#### Defined in

[packages/ice/src/ice.ts:64](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L64)

___

### remoteCandidatesEnd

• **remoteCandidatesEnd**: `boolean` = `false`

#### Defined in

[packages/ice/src/ice.ts:39](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L39)

___

### remoteIsLite

• **remoteIsLite**: `boolean` = `false`

#### Defined in

[packages/ice/src/ice.ts:31](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L31)

___

### remotePassword

• **remotePassword**: `string` = `""`

#### Defined in

[packages/ice/src/ice.ts:29](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L29)

___

### remoteUsername

• **remoteUsername**: `string` = `""`

#### Defined in

[packages/ice/src/ice.ts:30](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L30)

___

### state

• **state**: `IceState` = `"new"`

#### Defined in

[packages/ice/src/ice.ts:43](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L43)

___

### stateChanged

• `Readonly` **stateChanged**: `default`<[`IceState`]\>

#### Defined in

[packages/ice/src/ice.ts:47](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L47)

___

### stunServer

• `Optional` **stunServer**: readonly [`string`, `number`]

#### Defined in

[packages/ice/src/ice.ts:34](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L34)

___

### turnServer

• `Optional` **turnServer**: readonly [`string`, `number`]

#### Defined in

[packages/ice/src/ice.ts:35](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L35)

___

### useIpv4

• **useIpv4**: `boolean`

#### Defined in

[packages/ice/src/ice.ts:36](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L36)

___

### useIpv6

• **useIpv6**: `boolean`

#### Defined in

[packages/ice/src/ice.ts:37](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L37)

## Accessors

### nominatedKeys

• `get` **nominatedKeys**(): `string`[]

#### Returns

`string`[]

#### Defined in

[packages/ice/src/ice.ts:52](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L52)

___

### remoteAddr

• `get` **remoteAddr**(): readonly [`string`, `number`]

#### Returns

readonly [`string`, `number`]

#### Defined in

[packages/ice/src/ice.ts:56](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L56)

___

### remoteCandidates

• `get` **remoteCandidates**(): [`Candidate`](Candidate.md)[]

#### Returns

[`Candidate`](Candidate.md)[]

#### Defined in

[packages/ice/src/ice.ts:598](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L598)

• `set` **remoteCandidates**(`value`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `value` | [`Candidate`](Candidate.md)[] |

#### Returns

`void`

#### Defined in

[packages/ice/src/ice.ts:583](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L583)

## Methods

### addRemoteCandidate

▸ **addRemoteCandidate**(`remoteCandidate`): `Promise`<`void`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `remoteCandidate` | `undefined` \| [`Candidate`](Candidate.md) |

#### Returns

`Promise`<`void`\>

#### Defined in

[packages/ice/src/ice.ts:431](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L431)

___

### buildRequest

▸ `Private` **buildRequest**(`pair`, `nominate`): `Message`

#### Parameters

| Name | Type |
| :------ | :------ |
| `pair` | `CandidatePair` |
| `nominate` | `boolean` |

#### Returns

`Message`

#### Defined in

[packages/ice/src/ice.ts:866](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L866)

___

### checkComplete

▸ `Private` **checkComplete**(`pair`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `pair` | `CandidatePair` |

#### Returns

`void`

#### Defined in

[packages/ice/src/ice.ts:635](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L635)

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

#### Defined in

[packages/ice/src/ice.ts:791](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L791)

___

### checkStart

▸ **checkStart**(`pair`): `PCancelable`<`unknown`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `pair` | `CandidatePair` |

#### Returns

`PCancelable`<`unknown`\>

#### Defined in

[packages/ice/src/ice.ts:706](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L706)

___

### checkState

▸ `Private` **checkState**(`pair`, `state`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `pair` | `CandidatePair` |
| `state` | `CandidatePairState` |

#### Returns

`void`

#### Defined in

[packages/ice/src/ice.ts:625](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L625)

___

### close

▸ **close**(): `Promise`<`void`\>

#### Returns

`Promise`<`void`\>

#### Defined in

[packages/ice/src/ice.ts:387](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L387)

___

### connect

▸ **connect**(): `Promise`<`void`\>

#### Returns

`Promise`<`void`\>

#### Defined in

[packages/ice/src/ice.ts:215](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L215)

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

#### Defined in

[packages/ice/src/ice.ts:578](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L578)

___

### findPair

▸ `Private` **findPair**(`protocol`, `remoteCandidate`): `undefined` \| `CandidatePair`

#### Parameters

| Name | Type |
| :------ | :------ |
| `protocol` | `Protocol` |
| `remoteCandidate` | [`Candidate`](Candidate.md) |

#### Returns

`undefined` \| `CandidatePair`

#### Defined in

[packages/ice/src/ice.ts:616](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L616)

___

### gatherCandidates

▸ **gatherCandidates**(`cb?`): `Promise`<`void`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `cb?` | (`candidate`: [`Candidate`](Candidate.md)) => `void` |

#### Returns

`Promise`<`void`\>

#### Defined in

[packages/ice/src/ice.ts:82](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L82)

___

### getComponentCandidates

▸ `Private` **getComponentCandidates**(`component`, `addresses`, `timeout?`, `cb?`): `Promise`<[`Candidate`](Candidate.md)[]\>

#### Parameters

| Name | Type | Default value |
| :------ | :------ | :------ |
| `component` | `number` | `undefined` |
| `addresses` | `string`[] | `undefined` |
| `timeout` | `number` | `5` |
| `cb?` | (`candidate`: [`Candidate`](Candidate.md)) => `void` | `undefined` |

#### Returns

`Promise`<[`Candidate`](Candidate.md)[]\>

#### Defined in

[packages/ice/src/ice.ts:104](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L104)

___

### getDefaultCandidate

▸ **getDefaultCandidate**(`component`): `undefined` \| [`Candidate`](Candidate.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `component` | `number` |

#### Returns

`undefined` \| [`Candidate`](Candidate.md)

#### Defined in

[packages/ice/src/ice.ts:502](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L502)

___

### pairRemoteCandidate

▸ `Private` **pairRemoteCandidate**(`remoteCandidate`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `remoteCandidate` | [`Candidate`](Candidate.md) |

#### Returns

`void`

#### Defined in

[packages/ice/src/ice.ts:854](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L854)

___

### pruneComponents

▸ `Private` **pruneComponents**(): `void`

#### Returns

`void`

#### Defined in

[packages/ice/src/ice.ts:602](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L602)

___

### queryConsent

▸ `Private` **queryConsent**(): `PCancelable`<`unknown`\>

#### Returns

`PCancelable`<`unknown`\>

#### Defined in

[packages/ice/src/ice.ts:332](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L332)

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

#### Defined in

[packages/ice/src/ice.ts:512](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L512)

___

### respondError

▸ `Private` **respondError**(`request`, `addr`, `protocol`, `errorCode`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `request` | `Message` |
| `addr` | readonly [`string`, `number`] |
| `protocol` | `Protocol` |
| `errorCode` | [`number`, `string`] |

#### Returns

`void`

#### Defined in

[packages/ice/src/ice.ts:883](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L883)

___

### schedulingChecks

▸ `Private` **schedulingChecks**(): `boolean`

#### Returns

`boolean`

#### Defined in

[packages/ice/src/ice.ts:295](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L295)

___

### send

▸ **send**(`data`): `Promise`<`void`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |

#### Returns

`Promise`<`void`\>

#### Defined in

[packages/ice/src/ice.ts:473](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L473)

___

### sendTo

▸ `Private` **sendTo**(`data`, `component`): `Promise`<`void`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |
| `component` | `number` |

#### Returns

`Promise`<`void`\>

#### Defined in

[packages/ice/src/ice.ts:484](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L484)

___

### setState

▸ `Private` **setState**(`state`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `state` | `IceState` |

#### Returns

`void`

#### Defined in

[packages/ice/src/ice.ts:426](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L426)

___

### sortCheckList

▸ `Private` **sortCheckList**(): `void`

#### Returns

`void`

#### Defined in

[packages/ice/src/ice.ts:612](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L612)

___

### switchRole

▸ `Private` **switchRole**(`iceControlling`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `iceControlling` | `boolean` |

#### Returns

`void`

#### Defined in

[packages/ice/src/ice.ts:629](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L629)

___

### unfreezeInitial

▸ `Private` **unfreezeInitial**(): `void`

#### Returns

`void`

#### Defined in

[packages/ice/src/ice.ts:270](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/ice.ts#L270)

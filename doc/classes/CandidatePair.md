[werift](../README.md) / [Exports](../modules.md) / CandidatePair

# Class: CandidatePair

## Table of contents

### Constructors

- [constructor](CandidatePair.md#constructor)

### Properties

- [handle](CandidatePair.md#handle)
- [nominated](CandidatePair.md#nominated)
- [protocol](CandidatePair.md#protocol)
- [remoteCandidate](CandidatePair.md#remotecandidate)
- [remoteNominated](CandidatePair.md#remotenominated)

### Accessors

- [component](CandidatePair.md#component)
- [localCandidate](CandidatePair.md#localcandidate)
- [remoteAddr](CandidatePair.md#remoteaddr)
- [state](CandidatePair.md#state)

### Methods

- [toJSON](CandidatePair.md#tojson)
- [updateState](CandidatePair.md#updatestate)

## Constructors

### constructor

• **new CandidatePair**(`protocol`, `remoteCandidate`): [`CandidatePair`](CandidatePair.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `protocol` | [`Protocol`](../interfaces/Protocol.md) |
| `remoteCandidate` | [`Candidate`](Candidate.md) |

#### Returns

[`CandidatePair`](CandidatePair.md)

## Properties

### handle

• `Optional` **handle**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `cancel` | () => `void` |
| `done` | () => `boolean` |
| `promise` | `PCancelable`\<`any`\> |

___

### nominated

• **nominated**: `boolean` = `false`

___

### protocol

• **protocol**: [`Protocol`](../interfaces/Protocol.md)

___

### remoteCandidate

• **remoteCandidate**: [`Candidate`](Candidate.md)

___

### remoteNominated

• **remoteNominated**: `boolean` = `false`

## Accessors

### component

• `get` **component**(): `number`

#### Returns

`number`

___

### localCandidate

• `get` **localCandidate**(): [`Candidate`](Candidate.md)

#### Returns

[`Candidate`](Candidate.md)

___

### remoteAddr

• `get` **remoteAddr**(): readonly [`string`, `number`]

#### Returns

readonly [`string`, `number`]

___

### state

• `get` **state**(): [`CandidatePairState`](../enums/CandidatePairState.md)

#### Returns

[`CandidatePairState`](../enums/CandidatePairState.md)

## Methods

### toJSON

▸ **toJSON**(): `Object`

#### Returns

`Object`

| Name | Type |
| :------ | :------ |
| `protocol` | `string` |
| `remoteAddr` | readonly [`string`, `number`] |

___

### updateState

▸ **updateState**(`state`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `state` | [`CandidatePairState`](../enums/CandidatePairState.md) |

#### Returns

`void`

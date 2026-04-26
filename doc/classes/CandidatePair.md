[**werift**](../README.md) • **Docs**

***

[werift](../globals.md) / CandidatePair

# Class: CandidatePair

## Constructors

### new CandidatePair()

> **new CandidatePair**(`protocol`, `remoteCandidate`, `iceControlling`): [`CandidatePair`](CandidatePair.md)

#### Parameters

• **protocol**: [`Protocol`](../interfaces/Protocol.md)

• **remoteCandidate**: [`Candidate`](Candidate.md)

• **iceControlling**: `boolean`

#### Returns

[`CandidatePair`](CandidatePair.md)

## Properties

### handle?

> `optional` **handle**: `Cancelable`\<`void`\>

***

### iceControlling

> **iceControlling**: `boolean`

***

### id

> `readonly` **id**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

***

### nominated

> **nominated**: `boolean` = `false`

***

### protocol

> **protocol**: [`Protocol`](../interfaces/Protocol.md)

***

### remoteCandidate

> **remoteCandidate**: [`Candidate`](Candidate.md)

***

### remoteNominated

> **remoteNominated**: `boolean` = `false`

## Accessors

### component

> `get` **component**(): `number`

#### Returns

`number`

***

### json

> `get` **json**(): `object`

#### Returns

`object`

##### localCandidate

> **localCandidate**: `string`

##### protocol

> **protocol**: `string`

##### remoteCandidate

> **remoteCandidate**: `string`

***

### localCandidate

> `get` **localCandidate**(): [`Candidate`](Candidate.md)

#### Returns

[`Candidate`](Candidate.md)

***

### priority

> `get` **priority**(): `number`

#### Returns

`number`

***

### remoteAddr

> `get` **remoteAddr**(): readonly [`string`, `number`]

#### Returns

readonly [`string`, `number`]

***

### state

> `get` **state**(): [`CandidatePairState`](../enumerations/CandidatePairState.md)

#### Returns

[`CandidatePairState`](../enumerations/CandidatePairState.md)

## Methods

### toJSON()

> **toJSON**(): `object`

#### Returns

`object`

##### localCandidate

> **localCandidate**: `string`

##### protocol

> **protocol**: `string`

##### remoteCandidate

> **remoteCandidate**: `string`

***

### updateState()

> **updateState**(`state`): `void`

#### Parameters

• **state**: [`CandidatePairState`](../enumerations/CandidatePairState.md)

#### Returns

`void`

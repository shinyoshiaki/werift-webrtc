[**werift**](../README.md)

***

[werift](../globals.md) / CandidatePair

# Class: CandidatePair

## Implements

- [`CandidatePairStats`](../interfaces/CandidatePairStats.md)

## Constructors

### new CandidatePair()

> **new CandidatePair**(`protocol`, `remoteCandidate`, `iceControlling`): [`CandidatePair`](CandidatePair.md)

#### Parameters

##### protocol

[`Protocol`](../interfaces/Protocol.md)

##### remoteCandidate

[`Candidate`](Candidate.md)

##### iceControlling

`boolean`

#### Returns

[`CandidatePair`](CandidatePair.md)

## Properties

### bytesReceived

> **bytesReceived**: `number` = `0`

#### Implementation of

[`CandidatePairStats`](../interfaces/CandidatePairStats.md).[`bytesReceived`](../interfaces/CandidatePairStats.md#bytesreceived)

***

### bytesSent

> **bytesSent**: `number` = `0`

#### Implementation of

[`CandidatePairStats`](../interfaces/CandidatePairStats.md).[`bytesSent`](../interfaces/CandidatePairStats.md#bytessent)

***

### consentRequestsSent

> **consentRequestsSent**: `number` = `0`

#### Implementation of

[`CandidatePairStats`](../interfaces/CandidatePairStats.md).[`consentRequestsSent`](../interfaces/CandidatePairStats.md#consentrequestssent)

***

### handle?

> `optional` **handle**: `Cancelable`\<`void`\>

***

### iceControlling

> **iceControlling**: `boolean`

***

### id

> `readonly` **id**: `string`

***

### nominated

> **nominated**: `boolean` = `false`

***

### packetsReceived

> **packetsReceived**: `number` = `0`

#### Implementation of

[`CandidatePairStats`](../interfaces/CandidatePairStats.md).[`packetsReceived`](../interfaces/CandidatePairStats.md#packetsreceived)

***

### packetsSent

> **packetsSent**: `number` = `0`

#### Implementation of

[`CandidatePairStats`](../interfaces/CandidatePairStats.md).[`packetsSent`](../interfaces/CandidatePairStats.md#packetssent)

***

### protocol

> **protocol**: [`Protocol`](../interfaces/Protocol.md)

***

### remoteCandidate

> **remoteCandidate**: [`Candidate`](Candidate.md)

***

### remoteNominated

> **remoteNominated**: `boolean` = `false`

***

### requestsReceived

> **requestsReceived**: `number` = `0`

#### Implementation of

[`CandidatePairStats`](../interfaces/CandidatePairStats.md).[`requestsReceived`](../interfaces/CandidatePairStats.md#requestsreceived)

***

### requestsSent

> **requestsSent**: `number` = `0`

#### Implementation of

[`CandidatePairStats`](../interfaces/CandidatePairStats.md).[`requestsSent`](../interfaces/CandidatePairStats.md#requestssent)

***

### responsesReceived

> **responsesReceived**: `number` = `0`

#### Implementation of

[`CandidatePairStats`](../interfaces/CandidatePairStats.md).[`responsesReceived`](../interfaces/CandidatePairStats.md#responsesreceived)

***

### responsesSent

> **responsesSent**: `number` = `0`

#### Implementation of

[`CandidatePairStats`](../interfaces/CandidatePairStats.md).[`responsesSent`](../interfaces/CandidatePairStats.md#responsessent)

***

### roundTripTimeMeasurements

> **roundTripTimeMeasurements**: `number` = `0`

#### Implementation of

[`CandidatePairStats`](../interfaces/CandidatePairStats.md).[`roundTripTimeMeasurements`](../interfaces/CandidatePairStats.md#roundtriptimemeasurements)

***

### rtt?

> `optional` **rtt**: `number`

#### Implementation of

[`CandidatePairStats`](../interfaces/CandidatePairStats.md).[`rtt`](../interfaces/CandidatePairStats.md#rtt)

***

### totalRoundTripTime

> **totalRoundTripTime**: `number` = `0`

#### Implementation of

[`CandidatePairStats`](../interfaces/CandidatePairStats.md).[`totalRoundTripTime`](../interfaces/CandidatePairStats.md#totalroundtriptime)

## Accessors

### component

#### Get Signature

> **get** **component**(): `number`

##### Returns

`number`

***

### foundation

#### Get Signature

> **get** **foundation**(): `string`

##### Returns

`string`

***

### json

#### Get Signature

> **get** **json**(): `object`

##### Returns

`object`

###### localCandidate

> **localCandidate**: `string`

###### protocol

> **protocol**: `string`

###### remoteCandidate

> **remoteCandidate**: `string`

***

### localCandidate

#### Get Signature

> **get** **localCandidate**(): [`Candidate`](Candidate.md)

##### Returns

[`Candidate`](Candidate.md)

***

### priority

#### Get Signature

> **get** **priority**(): `number`

##### Returns

`number`

***

### remoteAddr

#### Get Signature

> **get** **remoteAddr**(): readonly \[`string`, `number`\]

##### Returns

readonly \[`string`, `number`\]

***

### state

#### Get Signature

> **get** **state**(): [`CandidatePairState`](../enumerations/CandidatePairState.md)

##### Returns

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

##### state

[`CandidatePairState`](../enumerations/CandidatePairState.md)

#### Returns

`void`

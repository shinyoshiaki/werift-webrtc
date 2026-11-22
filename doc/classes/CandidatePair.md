[**werift**](../README.md)

***

[werift](../globals.md) / CandidatePair

# Class: CandidatePair

## Implements

- [`CandidatePairStats`](../interfaces/CandidatePairStats.md)

## Constructors

### Constructor

> **new CandidatePair**(`protocol`, `remoteCandidate`, `iceControlling`): `CandidatePair`

#### Parameters

##### protocol

[`Protocol`](../interfaces/Protocol.md)

##### remoteCandidate

[`Candidate`](Candidate.md)

##### iceControlling

`boolean`

#### Returns

`CandidatePair`

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

> `optional` **handle?**: `Cancelable`\<`void`\>

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

### nomination

> **nomination**: `number` = `0`

The NOMINATION value this agent (controlling, renomination) sent for the
pair and the peer answered; 0 when it did not renominate the pair.

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

### remoteNomination

> **remoteNomination**: `number` = `0`

The largest nomination the peer sent for this pair while this agent was
controlled: the NOMINATION attribute's value (renomination), or 1 for
USE-CANDIDATE. The controlled agent selects the nominated pair with the
largest value, the higher-priority one between equal values.

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

### retransmissionsReceived

> **retransmissionsReceived**: `number` = `0`

#### Implementation of

[`CandidatePairStats`](../interfaces/CandidatePairStats.md).[`retransmissionsReceived`](../interfaces/CandidatePairStats.md#retransmissionsreceived)

***

### retransmissionsSent

> **retransmissionsSent**: `number` = `0`

#### Implementation of

[`CandidatePairStats`](../interfaces/CandidatePairStats.md).[`retransmissionsSent`](../interfaces/CandidatePairStats.md#retransmissionssent)

***

### roundTripTimeMeasurements

> **roundTripTimeMeasurements**: `number` = `0`

#### Implementation of

[`CandidatePairStats`](../interfaces/CandidatePairStats.md).[`roundTripTimeMeasurements`](../interfaces/CandidatePairStats.md#roundtriptimemeasurements)

***

### rtt?

> `optional` **rtt?**: `number`

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

### smoothedRtt

#### Get Signature

> **get** **smoothedRtt**(): `number` \| `undefined`

The smoothed RTT (seconds) the selection switches by: the median of the
last [RTT\_SMOOTHING\_SAMPLES](../variables/RTT_SMOOTHING_SAMPLES.md) samples, undefined with fewer than
[RTT\_SMOOTHING\_MIN\_SAMPLES](../variables/RTT_SMOOTHING_MIN_SAMPLES.md).

##### See

 - tests/ice/selection-controller.test.ts "the median of the last 5 samples: one outlier does not move it"
 - tests/ice/selection-controller.test.ts "equal priority: one outlier RTT of the other pair does not move the selection"

##### Returns

`number` \| `undefined`

***

### state

#### Get Signature

> **get** **state**(): [`CandidatePairState`](../enumerations/CandidatePairState.md)

##### Returns

[`CandidatePairState`](../enumerations/CandidatePairState.md)

## Methods

### noteIncomingRequest()

> **noteIncomingRequest**(`transactionId`): `boolean`

#### Parameters

##### transactionId

`string`

#### Returns

`boolean`

***

### recordRoundTrip()

> **recordRoundTrip**(`rtt`, `__namedParameters?`): `void`

Record the RTT (seconds) of an answered check: the totals, the samples of
[smoothedRtt](#smoothedrtt) and, unless `latest` is false (a response to an older
check than the one `rtt` came from), `rtt`.

#### Parameters

##### rtt

`number`

##### \_\_namedParameters?

###### latest?

`boolean` = `true`

#### Returns

`void`

#### See

tests/ice/selection-controller.test.ts "a response to an older check (latest: false) counts for the totals and the smoothed RTT, not the current RTT"

***

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

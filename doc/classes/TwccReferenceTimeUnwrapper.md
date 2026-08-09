[**werift**](../README.md)

***

[werift](../globals.md) / TwccReferenceTimeUnwrapper

# Class: TwccReferenceTimeUnwrapper

Tracks successive TWCC reference_time values and expands them to a
monotonic timeline (modulo unwrap).

## Constructors

### new TwccReferenceTimeUnwrapper()

> **new TwccReferenceTimeUnwrapper**(): [`TwccReferenceTimeUnwrapper`](TwccReferenceTimeUnwrapper.md)

#### Returns

[`TwccReferenceTimeUnwrapper`](TwccReferenceTimeUnwrapper.md)

## Methods

### rebasePacketResults()

> **rebasePacketResults**\<`T`\>(`results`, `referenceTimeUnits`): `T`[]

Re-base per-packet `receivedAtMs` produced by [TransportWideCC.packetResults](TransportWideCC.md#packetresults)
(which uses the raw 24-bit reference_time × 64) onto the continuous timeline.

#### Type Parameters

• **T** *extends* `object`

#### Parameters

##### results

`T`[]

packet results from one feedback

##### referenceTimeUnits

`number`

that feedback's reference_time

#### Returns

`T`[]

new array with adjusted `receivedAtMs` (other fields shallow-copied)

***

### reset()

> **reset**(): `void`

#### Returns

`void`

***

### unwrapBaseMs()

> **unwrapBaseMs**(`referenceTimeUnits`): `number`

#### Parameters

##### referenceTimeUnits

`number`

24-bit reference_time from a TWCC feedback

#### Returns

`number`

Continuous base receive time in ms (unwrapped × 64)

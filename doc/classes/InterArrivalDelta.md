[**werift**](../README.md)

***

[werift](../globals.md) / InterArrivalDelta

# Class: InterArrivalDelta

Packet batcher for delay-based GCC.
Unlike a naive "last packet" burst check, this keeps `firstSendMs` fixed so
continuous ≤5ms spacing still closes groups after `kSendTimeGroupLengthMs`.

## Constructors

### new InterArrivalDelta()

> **new InterArrivalDelta**(`sendTimeGroupLengthMs`): [`InterArrivalDelta`](InterArrivalDelta.md)

#### Parameters

##### sendTimeGroupLengthMs

`number` = `kSendTimeGroupLengthMs`

#### Returns

[`InterArrivalDelta`](InterArrivalDelta.md)

## Methods

### computeDeltas()

> **computeDeltas**(`sendMs`, `recvMs`, `packetSize`): `undefined` \| `InterArrivalDeltas`

Ingest one packet. When a completed previous group pair is available,
returns send/recv/size deltas; otherwise `undefined`.

#### Parameters

##### sendMs

`number`

##### recvMs

`number`

##### packetSize

`number`

#### Returns

`undefined` \| `InterArrivalDeltas`

***

### flush()

> **flush**(): `undefined` \| `InterArrivalDeltas`

Flush any in-progress group as complete (e.g. end of TWCC feedback batch).
Does not invent a following group; returns deltas vs prev if possible.

#### Returns

`undefined` \| `InterArrivalDeltas`

***

### reset()

> **reset**(): `void`

#### Returns

`void`

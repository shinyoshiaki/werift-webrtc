[**werift**](../README.md)

***

[werift](../globals.md) / InterArrivalDelta

# Class: InterArrivalDelta

Packet batcher for delay-based GCC.
Unlike a naive "last packet" burst check, this keeps `firstSendMs` fixed so
continuous ≤5ms spacing still closes groups after `kSendTimeGroupLengthMs`.

## Constructors

### Constructor

> **new InterArrivalDelta**(`sendTimeGroupLengthMs?`): `InterArrivalDelta`

#### Parameters

##### sendTimeGroupLengthMs?

`number` = `kSendTimeGroupLengthMs`

#### Returns

`InterArrivalDelta`

## Methods

### computeDeltas()

> **computeDeltas**(`sendMs`, `recvMs`, `packetSize`, `systemMs?`): `InterArrivalDeltas` \| `undefined`

Ingest one packet. When a completed previous group pair is available,
returns send/recv/size deltas; otherwise `undefined`.

#### Parameters

##### sendMs

`number`

##### recvMs

`number`

##### packetSize

`number`

##### systemMs?

`number`

pin `system_time` (feedback_time / sender clock). When
  omitted, receive time is stored so the arrival−system offset check is
  a no-op (same-domain). Production GCC passes sender-clock now.

#### Returns

`InterArrivalDeltas` \| `undefined`

***

### flush()

> **flush**(): `InterArrivalDeltas` \| `undefined`

Flush any in-progress group as complete (e.g. end of TWCC feedback batch).
Does not invent a following group; returns deltas vs prev if possible.

#### Returns

`InterArrivalDeltas` \| `undefined`

***

### reset()

> **reset**(): `void`

#### Returns

`void`

[**werift**](../README.md)

***

[werift](../globals.md) / AcknowledgedBitrateEstimator

# Class: AcknowledgedBitrateEstimator

Sliding-window robust throughput (libwebrtc RobustThroughputEstimator).

- Window: ≥ kRobustWindowPackets and ≥ kRobustMinWindowDurationMs,
  capped by max packets / max duration
- Replaces the largest receive gap with the second-largest (delay-spike guard)
- Returns min(send_rate, recv_rate); send side drops reordered-old packets

## Constructors

### new AcknowledgedBitrateEstimator()

> **new AcknowledgedBitrateEstimator**(): [`AcknowledgedBitrateEstimator`](AcknowledgedBitrateEstimator.md)

#### Returns

[`AcknowledgedBitrateEstimator`](AcknowledgedBitrateEstimator.md)

## Methods

### bitrate()

> **bitrate**(): `number`

#### Returns

`number`

estimated acked bitrate in bps, or 0 if not ready.

***

### incomingPacketFeedbackVector()

> **incomingPacketFeedbackVector**(`packets`): `void`

Ingest ACKed packets. Prefer **receive-time order** (libwebrtc
`SortedByReceiveTime`); out-of-order samples are insertion-sorted.

#### Parameters

##### packets

[`AckedPacketSample`](../interfaces/AckedPacketSample.md)[]

#### Returns

`void`

***

### reset()

> **reset**(): `void`

#### Returns

`void`

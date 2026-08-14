[**werift**](../README.md)

***

[werift](../globals.md) / LossBasedBwe

# Class: LossBasedBwe

LossBasedBweV2-aligned controller
(`modules/congestion_controller/goog_cc/loss_based_bwe_v2.*`).

- Partial observations accumulate until send-timeline duration ≥ 250ms
- Soft loss: not-received seqs live in a map and can be unmarked if later
  reported as received **before** the observation commits (pin
  PushBackObservation). `num_packets` / `size` increase on every feedback
  appearance; the lost map is keyed by seq. After commit, a late received
  is a new packet.
- Byte-loss objective/derivative when `UseByteLossRate` (default true)
- High-bandwidth bias adjusted by average loss ratio
- Instant upper/lower bounds + delayed-increase window + HOLD rate

## Constructors

### new LossBasedBwe()

> **new LossBasedBwe**(): [`LossBasedBwe`](LossBasedBwe.md)

#### Returns

[`LossBasedBwe`](LossBasedBwe.md)

## Accessors

### averageLossRatio

#### Get Signature

> **get** **averageLossRatio**(): `number`

##### Returns

`number`

***

### inherentLossEstimate

#### Get Signature

> **get** **inherentLossEstimate**(): `number`

##### Returns

`number`

***

### lossState

#### Get Signature

> **get** **lossState**(): [`LossBasedState`](../type-aliases/LossBasedState.md)

##### Returns

[`LossBasedState`](../type-aliases/LossBasedState.md)

***

### observationCount

#### Get Signature

> **get** **observationCount**(): `number`

Number of committed observations (for readiness tests).

##### Returns

`number`

***

### targetBitrateBps

#### Get Signature

> **get** **targetBitrateBps**(): `number`

##### Returns

`number`

## Methods

### reset()

> **reset**(`startBps`): `void`

#### Parameters

##### startBps

`number` = `kDefaultStartBitrateBps`

#### Returns

`void`

***

### setBandwidthEstimate()

> **setBandwidthEstimate**(`bandwidthBps`): `void`

State-preserving bandwidth update (libwebrtc
`LossBasedBweV2::SetBandwidthEstimate`).
Sets the loss-limited bandwidth and marks delay-based alignment without
clearing observation history, HOLD timers, or inherent-loss estimates.

#### Parameters

##### bandwidthBps

`number`

#### Returns

`void`

***

### setBitrateIfHigher()

> **setBitrateIfHigher**(`bps`): `void`

#### Parameters

##### bps

`number`

#### Returns

`void`

***

### setMinMaxBitrate()

> **setMinMaxBitrate**(`minBps`, `maxBps`): `void`

pin `LossBasedBweV2::SetMinMaxBitrate`.
`maxBps <= 0` / non-finite → [kMaxBitrateBps](../variables/kMaxBitrateBps.md) (1 Gbps).

#### Parameters

##### minBps

`number`

##### maxBps

`number`

#### Returns

`void`

***

### setPaddingDurationMs()

> **setPaddingDurationMs**(`ms`): `void`

pin PaddingDuration. 0 keeps `increasing`; >0 enters
`increase_using_padding` on loss-limited increase (maps to kLossLimitedBwe).

#### Parameters

##### ms

`number`

#### Returns

`void`

***

### update()

> **update**(`lossFraction`, `delayBasedBps`, `acknowledgedBps`, `packetCount`, `lostCount`, `firstSendMs`, `batchBytes`, `lastSendMs`, `lostBytes`, `packets`?, `inAlr`?): `number`

#### Parameters

##### lossFraction

`number`

fallback when packet counts are 0

##### delayBasedBps

`number`

delay-based A_hat

##### acknowledgedBps

`number` = `0`

recent acked bitrate (TWCC-relative throughput)

##### packetCount

`number` = `0`

known packets in batch

##### lostCount

`number` = `0`

lost among known

##### firstSendMs

`number` = `0`

actual first send time of this batch (send timeline)

##### batchBytes

`number` = `0`

total sent bytes in batch

##### lastSendMs

`number` = `0`

actual last send time of this batch (send timeline)

##### lostBytes

`number` = `0`

lost bytes in batch (byte-loss mode); if 0 with losses,
  approximated from average packet size

##### packets?

`LossPacketFeedback`[]

optional per-packet feedback for soft-loss map

##### inAlr?

`boolean` = `false`

pin `GetCandidates(in_alr)` — skip acked-rate in ALR

#### Returns

`number`

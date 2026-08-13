[**werift**](../README.md)

***

[werift](../globals.md) / ProbeController

# Class: ProbeController

Probe controller (libwebrtc ProbeController + BitrateProber FIFO +
ProbeBitrateEstimator).

Pacing vs result-wait are **separated** (libwebrtc BitrateProber):
- `pacing`: cluster currently being sent (at most one)
- `awaitingResults`: send-fill done; ProbeController still waiting for a
  result to decide further probing (sender-clock 1s lifetime)
- `estimatorHistory`: ProbeBitrateEstimator clusters kept after controller
  timeout so late TWCC can still produce estimates (receive-timeline 1s).
  Also pruned by **sender-side** age ([kSendTimeHistoryWindowMs](../variables/kSendTimeHistoryWindowMs.md)) so clusters
  that never receive ACK cannot grow unbounded.
- On **send** fill (minBytes AND minPackets), front is moved to awaiting and
  the next queued cluster becomes pacing — **without waiting for ACK**
- ACK / 80% estimate must **never** clear pacing (send-fill is independent)
- Controller timeout / cooldown / startMs use **sender clock**; estimator
  history prune uses **receive timeline** (`receivedAtMs`) plus sender age
- Zero-packet pacing timeouts are discarded (nothing measurable for TWCC)
- `setBitrates` / activate returns only **activated** configs (for pacing).
  In `complete`, a higher max than the previous max (and than the estimate)
  starts one probe at the new max (`probe_further=false`).
- Further via [setEstimatedBitrate](ProbeController.md#setestimatedbitrate) only while `waiting_for_result`
  (pin SetEstimatedBitrate); session `complete` sets
  `minBitrateToProbeFurther = +∞` (UpdateState(kProbingComplete))
- Recovery after complete uses [requestProbe](ProbeController.md#requestprobe) (not further threshold)

## Constructors

### new ProbeController()

> **new ProbeController**(): [`ProbeController`](ProbeController.md)

#### Returns

[`ProbeController`](ProbeController.md)

## Accessors

### activeClusterCount

#### Get Signature

> **get** **activeClusterCount**(): `0` \| `1`

##### Returns

`0` \| `1`

***

### awaitingResultCount

#### Get Signature

> **get** **awaitingResultCount**(): `number`

##### Returns

`number`

***

### currentProbeTargetBps

#### Get Signature

> **get** **currentProbeTargetBps**(): `number`

Pacing target = current pacing cluster only (not queued, not awaiting).

##### Returns

`number`

***

### estimatedBitrateBps

#### Get Signature

> **get** **estimatedBitrateBps**(): `number`

##### Returns

`number`

***

### estimatorHistoryCount

#### Get Signature

> **get** **estimatorHistoryCount**(): `number`

Clusters kept only for late TWCC measurement (tests / diagnostics).

##### Returns

`number`

***

### furtherProbeThresholdBps

#### Get Signature

> **get** **furtherProbeThresholdBps**(): `number`

Exposed for tests / diagnostics (last planned further-probe threshold).

##### Returns

`number`

***

### lastBandwidthLimitedCause

#### Get Signature

> **get** **lastBandwidthLimitedCause**(): [`BandwidthLimitedCause`](../type-aliases/BandwidthLimitedCause.md)

Last BandwidthLimitedCause (tests / diagnostics).

##### Returns

[`BandwidthLimitedCause`](../type-aliases/BandwidthLimitedCause.md)

***

### probeState

#### Get Signature

> **get** **probeState**(): [`ProbeState`](../type-aliases/ProbeState.md)

##### Returns

[`ProbeState`](../type-aliases/ProbeState.md)

***

### queuedClusterCount

#### Get Signature

> **get** **queuedClusterCount**(): `number`

##### Returns

`number`

***

### suggestedProbeBitrateBps

#### Get Signature

> **get** **suggestedProbeBitrateBps**(): `number`

##### Returns

`number`

## Methods

### abort()

> **abort**(`nowMs`): `void`

#### Parameters

##### nowMs

`number`

#### Returns

`void`

***

### enablePeriodicAlrProbing()

> **enablePeriodicAlrProbing**(`enable`): `void`

pin `EnablePeriodicAlrProbing`.

#### Parameters

##### enable

`boolean`

#### Returns

`void`

***

### onAckedPacket()

> **onAckedPacket**(`sizeBytes`, `receivedAtMs`, `isProbe`, `wideSeq`, `senderNowMs`, `sendingAtMs`?): `void`

ACK a probe packet. Credits the cluster that owned wideSeq (pacing or
awaiting). Does **not** advance or clear FIFO pacing — send-fill only.

Rate stats use min/max of ACKed send/receive times (libwebrtc
ProbeBitrateEstimator / SortedByReceiveTime semantics) so reorder does
not invert the receive interval.

80% ACK is the *minimum* to produce an estimate; further ACKs keep
updating cluster stats and may overwrite the pending estimate.

#### Parameters

##### sizeBytes

`number`

##### receivedAtMs

`number`

TWCC receiver timeline (rate math only)

##### isProbe

`boolean`

##### wideSeq

`undefined` | `number`

##### senderNowMs

`number`

sender clock for session completion / cooldown

##### sendingAtMs?

`number`

optional send time; defaults to seq map from ProbeSent

#### Returns

`void`

***

### onProbePacketSent()

> **onProbePacketSent**(`sizeBytes`, `sendMs`, `wideSeq`): `object`

Record a probation packet at **send** time (sender clock = sendMs).
When minBytes AND minPackets are met, pops pacing → awaitingResults and
activates the next queued cluster (libwebrtc BitrateProber::ProbeSent).

#### Parameters

##### sizeBytes

`number`

##### sendMs

`number`

##### wideSeq

`number`

#### Returns

`object`

newly activated pacing configs (may include the next FIFO cluster)

##### activated

> **activated**: [`ProbeClusterConfig`](../interfaces/ProbeClusterConfig.md)[]

##### clusterId

> **clusterId**: `number`

***

### process()

> **process**(`nowMs`): [`ProbeClusterConfig`](../interfaces/ProbeClusterConfig.md)[]

Advance **controller** timeouts using sender clock (`nowMs` = milliTime).
Does not erase ProbeBitrateEstimator seq maps — late TWCC may still
produce estimates from estimatorHistory.
Returns newly activated pacing configs (if any).

#### Parameters

##### nowMs

`number`

#### Returns

[`ProbeClusterConfig`](../interfaces/ProbeClusterConfig.md)[]

***

### remainingProbeBytes()

> **remainingProbeBytes**(`packetBytes`): `number`

Bytes still needed for the **pacing** cluster (padding injection).

#### Parameters

##### packetBytes

`number` = `200`

#### Returns

`number`

***

### requestProbe()

> **requestProbe**(`estimatedBps`, `nowMs`, `opts`?): [`ProbeClusterConfig`](../interfaces/ProbeClusterConfig.md)[]

pin `ProbeController::RequestProbe`.

Only while complete + (in ALR or ALR ended < 3s) + large drop within 5s.
Target is 0.85 × bitrate_before_last_large_drop. Always probe_further=false.

#### Parameters

##### estimatedBps

`number`

##### nowMs

`number`

##### opts?

###### maxProbeBps?

`number`

#### Returns

[`ProbeClusterConfig`](../interfaces/ProbeClusterConfig.md)[]

***

### reset()

> **reset**(`atTimeMs`): `void`

pin `ProbeController::Reset(at_time)`.

Keeps configuration: `enable_periodic_alr_probing_`, `network_available_`,
`alr_start_time_`, NSE probe interval. Sets drop / recovery cooldown
clocks to `atTimeMs` so RequestProbe cannot fire until
kMinTimeBetweenAlrProbesMs after reset.

#### Parameters

##### atTimeMs

`number` = `0`

#### Returns

`void`

***

### setAlrEndedTime()

> **setAlrEndedTime**(`endMs`): `void`

pin `SetAlrEndedTime`.

#### Parameters

##### endMs

`number`

#### Returns

`void`

***

### setAlrStartTime()

> **setAlrStartTime**(`startMs`): `void`

pin `SetAlrStartTime` (`undefined` = not in ALR).

#### Parameters

##### startMs

`undefined` | `number`

#### Returns

`void`

***

### setBitrates()

> **setBitrates**(`minBps`, `startBps`, `maxBps`, `nowMs`): [`ProbeClusterConfig`](../interfaces/ProbeClusterConfig.md)[]

#### Parameters

##### minBps

`number`

##### startBps

`number`

##### maxBps

`number`

##### nowMs

`number`

#### Returns

[`ProbeClusterConfig`](../interfaces/ProbeClusterConfig.md)[]

***

### setEstimatedBitrate()

> **setEstimatedBitrate**(`bitrateBps`, `nowMs`, `opts`?): [`ProbeClusterConfig`](../interfaces/ProbeClusterConfig.md)[]

Further-probe after a successful estimate update.

libwebrtc `ProbeController::SetEstimatedBitrate` only continues exponential
further probing while `state_ == kWaitingForProbingResult`. Once the session
is `kProbingComplete`, `min_bitrate_to_probe_further_` is +∞ and further
clusters are not opened from this path (recovery uses [requestProbe](ProbeController.md#requestprobe)).

`maxProbeBps` mirrors InitiateProbing max_probe_bitrate for the current
BandwidthLimitedCause (loss-limited increasing → estimated × 1.5).

#### Parameters

##### bitrateBps

`number`

##### nowMs

`number`

##### opts?

###### cause?

[`BandwidthLimitedCause`](../type-aliases/BandwidthLimitedCause.md)

###### maxProbeBps?

`number`

#### Returns

[`ProbeClusterConfig`](../interfaces/ProbeClusterConfig.md)[]

***

### setNetworkStateEstimate()

> **setNetworkStateEstimate**(`linkCapacityUpperBps`): `void`

pin `SetNetworkStateEstimate` — `linkCapacityUpperBps <= 0` clears.

#### Parameters

##### linkCapacityUpperBps

`number`

#### Returns

`void`

***

### setNetworkStateProbeIntervalMs()

> **setNetworkStateProbeIntervalMs**(`ms`): `void`

Override pin-default +∞ NSE probe interval (ms) so tests / callers can
enable TimeForNetworkStateProbe.

#### Parameters

##### ms

`number`

#### Returns

`void`

***

### shouldTagProbePacket()

> **shouldTagProbePacket**(): `boolean`

#### Returns

`boolean`

***

### takePendingEstimateBps()

> **takePendingEstimateBps**(): `number`

#### Returns

`number`

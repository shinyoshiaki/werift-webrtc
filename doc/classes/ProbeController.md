[**werift**](../README.md)

***

[werift](../globals.md) / ProbeController

# Class: ProbeController

Probe controller (libwebrtc ProbeController + BitrateProber FIFO +
ProbeBitrateEstimator).

Pacing vs result-wait are **separated** (libwebrtc BitrateProber):
- `pacing`: cluster currently being sent (at most one)
- `awaitingResults`: clusters whose send fill is done, waiting for TWCC ACK
- On **send** fill (minBytes AND minPackets), front is moved to awaiting and
  the next queued cluster becomes pacing — **without waiting for ACK**
- ACK / 80% estimate must **never** clear pacing (send-fill is independent)
- Timeout / cooldown / startMs use **sender clock** only; `receivedAtMs` is
  used solely for receive-rate estimation
- `setBitrates` / activate returns only **activated** configs (for pacing)

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

### furtherProbeThresholdBps

#### Get Signature

> **get** **furtherProbeThresholdBps**(): `number`

Exposed for tests / diagnostics (last planned further-probe threshold).

##### Returns

`number`

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

Advance timeouts using **sender clock** (`nowMs` = milliTime / Date.now).
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

> **requestProbe**(`estimatedBps`, `nowMs`): [`ProbeClusterConfig`](../interfaces/ProbeClusterConfig.md)[]

#### Parameters

##### estimatedBps

`number`

##### nowMs

`number`

#### Returns

[`ProbeClusterConfig`](../interfaces/ProbeClusterConfig.md)[]

***

### reset()

> **reset**(`_atTimeMs`): `void`

#### Parameters

##### \_atTimeMs

`number` = `0`

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

> **setEstimatedBitrate**(`bitrateBps`, `nowMs`): [`ProbeClusterConfig`](../interfaces/ProbeClusterConfig.md)[]

#### Parameters

##### bitrateBps

`number`

##### nowMs

`number`

#### Returns

[`ProbeClusterConfig`](../interfaces/ProbeClusterConfig.md)[]

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

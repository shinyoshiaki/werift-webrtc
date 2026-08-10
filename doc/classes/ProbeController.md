[**werift**](../README.md)

***

[werift](../globals.md) / ProbeController

# Class: ProbeController

Probe controller (libwebrtc `ProbeController` + `ProbeBitrateEstimator` +
BitrateProber FIFO semantics).

- `setBitrates` / cold start creates exponential configs (×3 then ×6)
- Configs are **queued**; only the **front** cluster is active for pacing
  and packet assignment (libwebrtc BitrateProber FIFO — not multi-active)
- InitiateProbing may still **return** both configs (started events) so the
  app can see planned clusters; only one is paced at a time
- Send fill requires **minBytes AND minPackets**; ACK validation uses 80%
- Recovery probes use current estimate + cooldown

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

### currentProbeTargetBps

#### Get Signature

> **get** **currentProbeTargetBps**(): `number`

Pacing target = front (only) active cluster bitrate.

##### Returns

`number`

***

### estimatedBitrateBps

#### Get Signature

> **get** **estimatedBitrateBps**(): `number`

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

Queued clusters waiting behind the front (e.g. 6x while 3x runs).

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

> **onAckedPacket**(`sizeBytes`, `receivedAtMs`, `isProbe`, `wideSeq`?): [`ProbeClusterConfig`](../interfaces/ProbeClusterConfig.md)[]

ACK a packet. Only credits the cluster that owned the wideSeq at send.
Applies ProbeBitrateEstimator validation before accepting a result.
On completion, pops front and activates the next queued cluster.

#### Parameters

##### sizeBytes

`number`

##### receivedAtMs

`number`

##### isProbe

`boolean`

##### wideSeq?

`number`

#### Returns

[`ProbeClusterConfig`](../interfaces/ProbeClusterConfig.md)[]

***

### onProbePacketSent()

> **onProbePacketSent**(`sizeBytes`, `sendMs`, `wideSeq`): `number`

Record a probation (probe-tagged) packet at send time.
Always assigns to the **front** active cluster.

#### Parameters

##### sizeBytes

`number`

##### sendMs

`number`

##### wideSeq

`number`

#### Returns

`number`

***

### process()

> **process**(`nowMs`): [`ProbeClusterConfig`](../interfaces/ProbeClusterConfig.md)[]

#### Parameters

##### nowMs

`number`

#### Returns

[`ProbeClusterConfig`](../interfaces/ProbeClusterConfig.md)[]

***

### remainingProbeBytes()

> **remainingProbeBytes**(`packetBytes`): `number`

Bytes still needed for the **front** active cluster (padding injection).
Considers both minBytes and a byte proxy for remaining minPackets.

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

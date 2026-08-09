[**werift**](../README.md)

***

[werift](../globals.md) / ProbeController

# Class: ProbeController

Probe controller (libwebrtc `ProbeController` + `ProbeBitrateEstimator`).

- `setBitrates` / cold start → exponential probe clusters (×3 and ×6)
- **Multi-active**: initial 3x/6x can be active simultaneously
- Per-packet **cluster id** (via wideSeq map) — ACKs credit one cluster only
- Result validation: min receive %, send/recv intervals, send/recv rate ratio
- Recovery probes use current estimate + cooldown

## Constructors

### new ProbeController()

> **new ProbeController**(): [`ProbeController`](ProbeController.md)

#### Returns

[`ProbeController`](ProbeController.md)

## Accessors

### activeClusterCount

#### Get Signature

> **get** **activeClusterCount**(): `number`

##### Returns

`number`

***

### currentProbeTargetBps

#### Get Signature

> **get** **currentProbeTargetBps**(): `number`

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

> **onAckedPacket**(`sizeBytes`, `receivedAtMs`, `isProbe`, `wideSeq`?): `void`

ACK a packet. Only credits the cluster that owned the wideSeq at send.
Applies ProbeBitrateEstimator validation before accepting a result.

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

`void`

***

### onProbePacketSent()

> **onProbePacketSent**(`sizeBytes`, `sendMs`, `wideSeq`): `number`

Record a probation (probe-tagged) packet at send time.
Assigns the packet to one active cluster and stores wideSeq → clusterId.

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

> **remainingProbeBytes**(): `number`

Bytes still needed across active clusters (for padding injection).

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

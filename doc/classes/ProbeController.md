[**werift**](../README.md)

***

[werift](../globals.md) / ProbeController

# Class: ProbeController

Probe controller (libwebrtc `ProbeController` structure).

- `setBitrates` / cold start → exponential probe clusters (×3 and ×6)
- **Multi-active**: initial 3x/6x (and any co-enqueued set) can be active
  simultaneously; pacing target is the max among active clusters
- On successful TWCC-measured probe, may schedule further probing when the
  estimate exceeds `further_probe_threshold` × last probe size

The sender must raise its pacing rate to `currentProbeTargetBps` and tag
packets with `isProbation` while any cluster is active.

## Constructors

### new ProbeController()

> **new ProbeController**(): [`ProbeController`](ProbeController.md)

#### Returns

[`ProbeController`](ProbeController.md)

## Accessors

### activeClusterCount

#### Get Signature

> **get** **activeClusterCount**(): `number`

Number of currently active probe clusters.

##### Returns

`number`

***

### currentProbeTargetBps

#### Get Signature

> **get** **currentProbeTargetBps**(): `number`

Max active cluster pacing target (0 if none).

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

Alias used by callers expecting “suggested” naming.

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

> **onAckedPacket**(`sizeBytes`, `receivedAtMs`, `isProbe`): `void`

#### Parameters

##### sizeBytes

`number`

##### receivedAtMs

`number`

##### isProbe

`boolean`

#### Returns

`void`

***

### process()

> **process**(`nowMs`): [`ProbeClusterConfig`](../interfaces/ProbeClusterConfig.md)[]

Advance timeouts / promote queued clusters.

#### Parameters

##### nowMs

`number`

#### Returns

[`ProbeClusterConfig`](../interfaces/ProbeClusterConfig.md)[]

***

### requestProbe()

> **requestProbe**(`estimatedBps`, `nowMs`): [`ProbeClusterConfig`](../interfaces/ProbeClusterConfig.md)[]

Application / recovery request for additional probes.

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

libwebrtc SetBitrates — configure bounds and initiate exponential probing
when still in the init state.

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

[**werift**](../README.md)

***

[werift](../globals.md) / RttBasedBackoff

# Class: RttBasedBackoff

libwebrtc `RttBasedBackoff` (send_side_bandwidth_estimation.{h,cc}).

IsRttAboveLimit uses **propagation RTT** (CorrectedRtt), not raw max
feedback RTT. When above limit, pin `SendSideBandwidthEstimation::UpdateEstimate`
multiplies the target by drop_fraction every drop_interval down to
bandwidth_floor — see [GccBandwidthEstimator](GccBandwidthEstimator.md) sender-clock process.

Field-trial default: WebRTC-Bwe-MaxRttLimit limit=3s, fraction=0.8,
interval=1s, floor=5kbps (Enabled).

## Constructors

### new RttBasedBackoff()

> **new RttBasedBackoff**(`rttLimitMs`): [`RttBasedBackoff`](RttBasedBackoff.md)

#### Parameters

##### rttLimitMs

`number` = `kRttBasedBackOffHighRttMs`

#### Returns

[`RttBasedBackoff`](RttBasedBackoff.md)

## Accessors

### lastPropagationRtt

#### Get Signature

> **get** **lastPropagationRtt**(): `number`

Last stored propagation RTT (without timeout correction).

##### Returns

`number`

## Methods

### correctedRttMs()

> **correctedRttMs**(): `number`

CorrectedRtt = max(last_packet_sent − last_update, 0) + last_propagation_rtt.
Avoids false timeout when no packets are being sent.

#### Returns

`number`

***

### isRttAboveLimit()

> **isRttAboveLimit**(): `boolean`

True when CorrectedRtt > configured limit (default 3s).

#### Returns

`boolean`

***

### onSentPacket()

> **onSentPacket**(`sendTimeMs`): `void`

libwebrtc RttBasedBackoff::OnSentPacket (last_packet_sent_).

#### Parameters

##### sendTimeMs

`number`

#### Returns

`void`

***

### reset()

> **reset**(): `void`

#### Returns

`void`

***

### updatePropagationRtt()

> **updatePropagationRtt**(`atTimeMs`, `propagationRttMs`): `void`

libwebrtc UpdatePropagationRtt — store min_propagation_rtt from the batch.

#### Parameters

##### atTimeMs

`number`

##### propagationRttMs

`number`

#### Returns

`void`

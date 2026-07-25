[**werift**](../README.md)

***

[werift](../globals.md) / ProbePacingController

# Interface: ProbePacingController

Optional probe / pacing control surface used by [RTCRtpSender](../classes/RTCRtpSender.md).

Not part of the common [BandwidthEstimator](BandwidthEstimator.md) contract — only estimators
that implement probing (e.g. GCC) need this. Use [isProbePacingController](../functions/isProbePacingController.md).

## Methods

### getPacingBitrateBps()

> **getPacingBitrateBps**(): `number`

Pacing target (bps) for the send engine.
Typically `max(availableBitrate, activeProbeTarget)`.

#### Returns

`number`

***

### pendingProbePaddingPackets()

> **pendingProbePaddingPackets**(`packetBytes`?): `number`

Number of padding packets the sender should inject to fill the active
probe cluster when media alone is insufficient.

#### Parameters

##### packetBytes?

`number`

#### Returns

`number`

***

### shouldTagProbePacket()

> **shouldTagProbePacket**(): `boolean`

Tag the next outgoing packet as a probe (`SentInfo.isProbation`).

#### Returns

`boolean`

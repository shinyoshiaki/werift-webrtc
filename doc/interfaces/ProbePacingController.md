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
pin GetPacingRates: estimate × 2.5 before first TWCC, × 1.1 after,
raised to the active probe target while probing.

#### Returns

`number`

***

### getPaddingBitrateBps()?

> `optional` **getPaddingBitrateBps**(): `number`

pin `GetPacingRates` padding_rate while loss-limited
`kIncreaseUsingPadding`. 0 when not in that state.

#### Returns

`number`

***

### pendingLossPaddingPackets()?

> `optional` **pendingLossPaddingPackets**(`packetBytes`?): `number`

Padding packets to send to approach [getPaddingBitrateBps](ProbePacingController.md#getpaddingbitratebps) when
media is sparse. Not probe/probation packets.

#### Parameters

##### packetBytes?

`number`

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

### reserveOutgoingProbe()

> **reserveOutgoingProbe**(`nowMs`): `undefined` \| \{ `clusterId`: `number`; `nextSendTimeMs`: `number`; \}

pin `BitrateProber::CurrentCluster` — reserve the active probe cluster
**before** the packet is sent (not at send-complete callback).

#### Parameters

##### nowMs

`number`

#### Returns

`undefined` \| \{ `clusterId`: `number`; `nextSendTimeMs`: `number`; \}

***

### shouldTagProbePacket()

> **shouldTagProbePacket**(): `boolean`

Tag the next outgoing packet as a probe (`SentInfo.isProbation`).

#### Returns

`boolean`

[**werift**](../README.md)

***

[werift](../globals.md) / RTCRtpSender

# Class: RTCRtpSender

## Constructors

### new RTCRtpSender()

> **new RTCRtpSender**(`trackOrKind`): [`RTCRtpSender`](RTCRtpSender.md)

#### Parameters

##### trackOrKind

[`Kind`](../type-aliases/Kind.md) | [`MediaStreamTrack`](MediaStreamTrack.md)

#### Returns

[`RTCRtpSender`](RTCRtpSender.md)

## Properties

### codec?

> `optional` **codec**: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)

***

### dtlsTransport

> **dtlsTransport**: [`RTCDtlsTransport`](RTCDtlsTransport.md)

***

### kind

> `readonly` **kind**: [`Kind`](../type-aliases/Kind.md)

***

### onAvailableBitrate

> `readonly` **onAvailableBitrate**: [`Event`](Event.md)\<\[`number`\]\>

Stable recommended send bitrate event (**bps**, change-only).
Bridged from the active [BandwidthEstimator](../interfaces/BandwidthEstimator.md); subscriptions survive
[setBandwidthEstimator](RTCRtpSender.md#setbandwidthestimator) without re-subscribing.

Prefer this over `senderBWE.onAvailableBitrate` for application adaptation.

***

### onGenericNack

> `readonly` **onGenericNack**: [`Event`](Event.md)\<\[[`GenericNack`](GenericNack.md)\]\>

***

### onPictureLossIndication

> `readonly` **onPictureLossIndication**: [`Event`](Event.md)\<\[\]\>

***

### onProbeClusterConfig

> `readonly` **onProbeClusterConfig**: [`Event`](Event.md)\<\[\{ `id`: `number`; `minDurationMs`: `number`; `minPackets`: `number`; `targetBps`: `number`; \}\]\>

GCC probe cluster configs (target bps / min packets). Bridged when the
active estimator is [GccBandwidthEstimator](GccBandwidthEstimator.md).

***

### onReady

> `readonly` **onReady**: [`Event`](Event.md)\<`any`[]\>

***

### onRtcp

> `readonly` **onRtcp**: [`Event`](Event.md)\<\[[`RtcpPacket`](../type-aliases/RtcpPacket.md)\]\>

***

### receiverEstimatedMaxBitrate

> **receiverEstimatedMaxBitrate**: `bigint` = `0n`

***

### redEncoder

> **redEncoder**: [`RedEncoder`](RedEncoder.md)

***

### redRedundantPayloadType?

> `optional` **redRedundantPayloadType**: `number`

***

### rtcpRunning

> **rtcpRunning**: `boolean` = `false`

***

### rtxSsrc

> `readonly` **rtxSsrc**: `number`

***

### ssrc

> `readonly` **ssrc**: `number`

***

### stopped

> **stopped**: `boolean` = `false`

***

### streamIds

> **streamIds**: `string`[] = `[]`

***

### track

> **track**: `null` \| [`MediaStreamTrack`](MediaStreamTrack.md) = `null`

***

### trackId

> `readonly` **trackId**: `string`

***

### trackOrKind

> **trackOrKind**: [`Kind`](../type-aliases/Kind.md) \| [`MediaStreamTrack`](MediaStreamTrack.md)

***

### type

> `readonly` **type**: `"sender"` = `"sender"`

## Accessors

### pacingBitrateBps

#### Get Signature

> **get** **pacingBitrateBps**(): `number`

Effective send pacing rate (bps): estimator estimate, raised to the active
probe target while probing. 0 when unknown.

##### Returns

`number`

***

### redDistance

#### Get Signature

> **get** **redDistance**(): `number`

##### Returns

`number`

#### Set Signature

> **set** **redDistance**(`n`): `void`

##### Parameters

###### n

`number`

##### Returns

`void`

***

### senderBWE

#### Get Signature

> **get** **senderBWE**(): [`BandwidthEstimator`](../interfaces/BandwidthEstimator.md)

Active send-side bandwidth estimator (TWCC-driven).

Default is [SenderBandwidthEstimator](LegacyCumulativeBandwidthEstimator.md) (legacy cumulative algorithm).
Replace only with [setBandwidthEstimator](RTCRtpSender.md#setbandwidthestimator) (e.g. `new GccBandwidthEstimator()`).

Prefer [onAvailableBitrate](RTCRtpSender.md#onavailablebitrate) on this sender for bitrate notifications that
survive estimator swaps. Algorithm-specific events remain on concrete instances.

##### Returns

[`BandwidthEstimator`](../interfaces/BandwidthEstimator.md)

***

### streamId

#### Get Signature

> **get** **streamId**(): `undefined` \| `string`

##### Returns

`undefined` \| `string`

#### Set Signature

> **set** **streamId**(`value`): `void`

##### Parameters

###### value

`undefined` | `string`

##### Returns

`void`

***

### transport

#### Get Signature

> **get** **transport**(): [`RTCDtlsTransport`](RTCDtlsTransport.md)

##### Returns

[`RTCDtlsTransport`](RTCDtlsTransport.md)

## Methods

### collectStats()

> **collectStats**(`timestamp`): [`RTCStats`](../interfaces/RTCStats.md)[]

#### Parameters

##### timestamp

`number`

#### Returns

[`RTCStats`](../interfaces/RTCStats.md)[]

***

### getParameters()

> **getParameters**(): `object`

#### Returns

`object`

##### encodings

> **encodings**: `object`[]

###### Index Signature

\[`key`: `string`\]: `unknown`

***

### getStats()

> **getStats**(): `Promise`\<[`RTCStatsReport`](RTCStatsReport.md)\>

#### Returns

`Promise`\<[`RTCStatsReport`](RTCStatsReport.md)\>

***

### getStatsRootIds()

> **getStatsRootIds**(): `string`[]

#### Returns

`string`[]

***

### handleRtcpPacket()

> **handleRtcpPacket**(`rtcpPacket`): `void`

#### Parameters

##### rtcpPacket

[`RtcpPacket`](../type-aliases/RtcpPacket.md)

#### Returns

`void`

***

### maybeInjectLossPadding()

> **maybeInjectLossPadding**(): `Promise`\<`number`\>

pin padding_rate while LossBased is `kIncreaseUsingPadding`.
Regular RTP padding (not probe/probation). Probe padding takes priority.

#### Returns

`Promise`\<`number`\>

***

### maybeInjectProbePadding()

> **maybeInjectProbePadding**(): `Promise`\<`number`\>

#### Returns

`Promise`\<`number`\>

***

### prepareSend()

> **prepareSend**(`params`): `void`

#### Parameters

##### params

[`RTCRtpParameters`](../interfaces/RTCRtpParameters.md)

#### Returns

`void`

***

### registerTrack()

> **registerTrack**(`track`): `void`

#### Parameters

##### track

[`MediaStreamTrack`](MediaStreamTrack.md)

#### Returns

`void`

***

### replaceRTP()

> **replaceRTP**(`__namedParameters`, `discontinuity`): `void`

#### Parameters

##### \_\_namedParameters

`Pick`\<[`RtpHeader`](RtpHeader.md), `"sequenceNumber"` \| `"timestamp"`\>

##### discontinuity

`boolean` = `false`

#### Returns

`void`

***

### replaceTrack()

> **replaceTrack**(`track`): `Promise`\<`void`\>

#### Parameters

##### track

`null` | [`MediaStreamTrack`](MediaStreamTrack.md)

#### Returns

`Promise`\<`void`\>

***

### runRtcp()

> **runRtcp**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

***

### sendRtp()

> **sendRtp**(`rtp`): `Promise`\<`void`\>

#### Parameters

##### rtp

`Buffer`\<`ArrayBufferLike`\> | [`RtpPacket`](RtpPacket.md)

#### Returns

`Promise`\<`void`\>

***

### setBandwidthEstimator()

> **setBandwidthEstimator**(`impl`): `void`

Replace the send-side bandwidth estimator used for TWCC-driven BWE.

Default is the legacy [SenderBandwidthEstimator](LegacyCumulativeBandwidthEstimator.md). Pass e.g.
`new GccBandwidthEstimator()` to use Google Congestion Control.

Behavior on swap:
1. Bumps bweGeneration so in-flight sends discard `rtpPacketSent`
   delivery and in-flight [maybeInjectProbePadding](RTCRtpSender.md#maybeinjectprobepadding) loops exit
   (cancelled — no packets to disposed / previous estimator).
2. Stops delivering `rtpPacketSent` / `receiveTWCC` to the previous instance.
3. Unbinds the stable [onAvailableBitrate](RTCRtpSender.md#onavailablebitrate) bridge, then `dispose()`/`reset()` the old instance.
4. **Always** `reset()` the injected `impl` so a previously used instance
   starts clean (no implicit state merge), then rebinds the bridge.

Subscriptions to [onAvailableBitrate](RTCRtpSender.md#onavailablebitrate) on this sender are preserved.
Re-subscribe algorithm-specific events on the new concrete instance.

#### Parameters

##### impl

[`BandwidthEstimator`](../interfaces/BandwidthEstimator.md)

#### Returns

`void`

***

### setDtlsTransport()

> **setDtlsTransport**(`dtlsTransport`): `void`

#### Parameters

##### dtlsTransport

[`RTCDtlsTransport`](RTCDtlsTransport.md)

#### Returns

`void`

***

### setParameters()

> **setParameters**(`params`): `void`

#### Parameters

##### params

###### encodings?

`Record`\<`string`, `unknown`\>[]

#### Returns

`void`

***

### setSendEncodings()

> **setSendEncodings**(`encodings`): `void`

#### Parameters

##### encodings

`Record`\<`string`, `unknown`\>[] = `[]`

#### Returns

`void`

***

### setStreams()

> **setStreams**(`streams`): `void`

#### Parameters

##### streams

[`MediaStream`](MediaStream.md)[] = `[]`

#### Returns

`void`

***

### stop()

> **stop**(): `void`

#### Returns

`void`

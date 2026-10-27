[**werift**](../README.md)

***

[werift](../globals.md) / RTCRtpSender

# Class: RTCRtpSender

## Constructors

### Constructor

> **new RTCRtpSender**(`trackOrKind`, `options?`): `RTCRtpSender`

#### Parameters

##### trackOrKind

[`Kind`](../type-aliases/Kind.md) \| [`MediaStreamTrack`](MediaStreamTrack.md)

##### options?

[`RTCRtpSenderOptions`](../type-aliases/RTCRtpSenderOptions.md)

#### Returns

`RTCRtpSender`

## Properties

### codec?

> `optional` **codec?**: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)

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
[setBandwidthEstimator](#setbandwidthestimator) without re-subscribing.

Prefer this over `senderBWE.onAvailableBitrate` for application adaptation.

***

### onGenericNack

> `readonly` **onGenericNack**: [`Event`](Event.md)\<\[[`GenericNack`](GenericNack.md)\]\>

***

### onPictureLossIndication

> `readonly` **onPictureLossIndication**: [`Event`](Event.md)\<\[\]\>

***

### onProbeClusterConfig

> `readonly` **onProbeClusterConfig**: [`Event`](Event.md)\<\[[`ProbeClusterConfig`](../interfaces/ProbeClusterConfig.md)\]\>

Probe cluster configs (target bps / min packets). Bridged from the active
[BandwidthEstimator](../interfaces/BandwidthEstimator.md); GCC fires this, legacy / disabled never do.

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

> `optional` **redRedundantPayloadType?**: `number`

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

> **track**: [`MediaStreamTrack`](MediaStreamTrack.md) \| `null` = `null`

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
probe target while probing. 0 when unknown. Legacy returns 0 from
[BandwidthEstimator.getPacingBitrateBps](../interfaces/BandwidthEstimator.md#getpacingbitratebps) so media is unpaced.

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

> **get** **senderBWE**(): [`BandwidthEstimator`](../interfaces/BandwidthEstimator.md) & [`LegacyCongestionCompatibility`](../type-aliases/LegacyCongestionCompatibility.md)

Active send-side bandwidth estimator (TWCC-driven).

Default is [SenderBandwidthEstimator](LegacyCumulativeBandwidthEstimator.md) (legacy cumulative algorithm).
Replace only with [setBandwidthEstimator](#setbandwidthestimator) (e.g. `new GccBandwidthEstimator()`).

Prefer [onAvailableBitrate](#onavailablebitrate) on this sender for bitrate notifications that
survive estimator swaps. Algorithm-specific events remain on concrete instances.

**TypeScript compatibility:** [LegacyCongestionCompatibility](../type-aliases/LegacyCongestionCompatibility.md) fields
(`onCongestion` / `onCongestionScore`) are present on every estimator so
existing `sender.senderBWE.onCongestion.subscribe(...)` still type-checks.
They fire only on [SenderBandwidthEstimator](LegacyCumulativeBandwidthEstimator.md); GCC / disabled are no-ops.
Prefer `sender.senderBWE as SenderBandwidthEstimator` (or
[isSenderBandwidthEstimator](../functions/isSenderBandwidthEstimator.md)) for legacy-only APIs.

##### Returns

[`BandwidthEstimator`](../interfaces/BandwidthEstimator.md) & [`LegacyCongestionCompatibility`](../type-aliases/LegacyCongestionCompatibility.md)

***

### streamId

#### Get Signature

> **get** **streamId**(): `string` \| `undefined`

##### Returns

`string` \| `undefined`

#### Set Signature

> **set** **streamId**(`value`): `void`

##### Parameters

###### value

`string` \| `undefined`

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

### detachTrack()

> **detachTrack**(): `void`

Detach the current track without stopping the sender (`removeTrack`).
The same sender can resume sending after `replaceTrack(track)`.

#### Returns

`void`

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

Inject RTP padding packets while a GCC probe cluster is active and media
alone has not yet filled min packets / min bitrate×duration.

Responsibility split:
- Estimator (`ProbeController` / `pendingProbePaddingPackets`) decides need
- Sender generates padding-only RTP on the RTX SSRC with a TWCC seq +
  `isProbation` and paces them

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

### proposeSend()

> **proposeSend**(`codecs`): `void`

Internal: a pending remote offer proposes `codecs` for the answer while
the committed codec keeps sending until the final answer.

#### Parameters

##### codecs

[`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[]

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

> **replaceRTP**(`header`, `discontinuity?`, `timestampStep?`): `void`

Schedule RTP continuity rewrite for the next packet that is actually sent.
The header argument is kept for API compatibility and is not used to compute
offsets. `discontinuity` does not change sequence or timestamp mapping.
`timestampStep` (default 1) is the only way to choose the timestamp increment
at the source-switch boundary.

#### Parameters

##### header

`Pick`\<[`RtpHeader`](RtpHeader.md), `"sequenceNumber"` \| `"timestamp"`\>

##### discontinuity?

`boolean` = `false`

##### timestampStep?

`number` = `1`

#### Returns

`void`

***

### replaceTrack()

> **replaceTrack**(`track`): `Promise`\<`void`\>

#### Parameters

##### track

[`MediaStreamTrack`](MediaStreamTrack.md) \| `null`

#### Returns

`Promise`\<`void`\>

***

### restoreSendParams()

> **restoreSendParams**(`snapshot`): `void`

Internal: return to a negotiation baseline's send parameters.

#### Parameters

##### snapshot

###### cname

`string` \| `undefined` = `...`

###### codec

[`RTCRtpCodecParameters`](RTCRtpCodecParameters.md) \| `undefined` = `...`

###### headerExtensions

[`RTCRtpHeaderExtensionParameters`](RTCRtpHeaderExtensionParameters.md)[] = `...`

###### mid

`string` \| `undefined` = `...`

###### negotiatedCodecs

[`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[] = `...`

###### proposedPrimaryCodec

[`RTCRtpCodecParameters`](RTCRtpCodecParameters.md) \| `undefined` = `...`

###### redRedundantPayloadType

`number` \| `undefined` = `...`

###### repairedRtpStreamId

`string` \| `undefined` = `...`

###### rtpStreamId

`string` \| `undefined` = `...`

###### rtxPayloadType

`number` \| `undefined` = `...`

###### sendPrimaryCodec

[`RTCRtpCodecParameters`](RTCRtpCodecParameters.md) \| `undefined` = `...`

###### track

[`MediaStreamTrack`](MediaStreamTrack.md) \| `null` = `...`

###### trackCodec

[`RTCRtpCodecParameters`](RTCRtpCodecParameters.md) \| `undefined` = `...`

#### Returns

`void`

***

### runRtcp()

> **runRtcp**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

***

### sendRtp()

> **sendRtp**(`rtp`): `Promise`\<`void`\>

Send immediately by default or queue until DTLS is ready when pending RTP
is enabled. Each call settles only after its own packet is sent or dropped.

#### Parameters

##### rtp

`Buffer`\<`ArrayBufferLike`\> \| [`RtpPacket`](RtpPacket.md)

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
   delivery and in-flight [maybeInjectProbePadding](#maybeinjectprobepadding) loops exit
   (cancelled — no packets to disposed / previous estimator).
2. Clears pendingUntrackedBytes so the next estimator's first
   `SentInfo.priorUnackedBytes` is 0.
3. Stops delivering `rtpPacketSent` / `receiveTWCC` to the previous instance.
3. Unbinds the stable [onAvailableBitrate](#onavailablebitrate) bridge, then `dispose()`/`reset()` the old instance.
4. **Always** `reset()` the injected `impl` so a previously used instance
   starts clean (no implicit state merge), then rebinds the bridge.

Subscriptions to [onAvailableBitrate](#onavailablebitrate) on this sender are preserved.
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

> **setSendEncodings**(`encodings?`): `void`

#### Parameters

##### encodings?

`Record`\<`string`, `unknown`\>[] = `[]`

#### Returns

`void`

***

### setStreams()

> **setStreams**(`streams?`): `void`

#### Parameters

##### streams?

[`MediaStream`](MediaStream.md)[] = `[]`

#### Returns

`void`

***

### snapshotSendParams()

> **snapshotSendParams**(): `object`

Internal: the negotiated send parameters, for a negotiation baseline.

#### Returns

`object`

##### cname

> **cname**: `string` \| `undefined`

##### codec

> **codec**: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md) \| `undefined`

##### headerExtensions

> **headerExtensions**: [`RTCRtpHeaderExtensionParameters`](RTCRtpHeaderExtensionParameters.md)[]

##### mid

> **mid**: `string` \| `undefined`

##### negotiatedCodecs

> **negotiatedCodecs**: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[]

##### proposedPrimaryCodec

> **proposedPrimaryCodec**: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md) \| `undefined`

##### redRedundantPayloadType

> **redRedundantPayloadType**: `number` \| `undefined`

##### repairedRtpStreamId

> **repairedRtpStreamId**: `string` \| `undefined`

##### rtpStreamId

> **rtpStreamId**: `string` \| `undefined`

##### rtxPayloadType

> **rtxPayloadType**: `number` \| `undefined`

##### sendPrimaryCodec

> **sendPrimaryCodec**: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md) \| `undefined`

##### track

> **track**: [`MediaStreamTrack`](MediaStreamTrack.md) \| `null`

##### trackCodec

> **trackCodec**: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md) \| `undefined`

***

### stop()

> **stop**(`__namedParameters?`): `void`

#### Parameters

##### \_\_namedParameters?

###### keepTrack?

`boolean` = `false`

#### Returns

`void`

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

[`RTCRtpSenderOptions`](../type-aliases/RTCRtpSenderOptions.md) = `{}`

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

### onGenericNack

> `readonly` **onGenericNack**: [`Event`](Event.md)\<\[[`GenericNack`](GenericNack.md)\]\>

***

### onPictureLossIndication

> `readonly` **onPictureLossIndication**: [`Event`](Event.md)\<\[\]\>

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

### senderBWE

> `readonly` **senderBWE**: `SenderBandwidthEstimator`

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

### retransmit()

> **retransmit**(`sequenceNumbers`, `options?`): `Promise`\<`number`[]\>

nonstandard: retransmit packets still in the send history, as a generic
NACK does. Use it for NACKs that arrive outside RTCP, such as an
application-layer NACK over a DataChannel. With RTX negotiated the packets
are wrapped in RTX; otherwise they are resent on the media SSRC.

#### Parameters

##### sequenceNumbers

`number`[]

##### options?

[`RTCRtpRetransmitOptions`](../type-aliases/RTCRtpRetransmitOptions.md) = `{}`

#### Returns

`Promise`\<`number`[]\>

the sequence numbers actually retransmitted

***

### runRtcp()

> **runRtcp**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

***

### sendRtp()

> **sendRtp**(`rtp`): `Promise`\<`void`\>

Send an RTP packet. Pending RTP is disabled by default: the packet is
written immediately if DTLS is connected and a codec is set, otherwise
dropped.

When pending RTP is enabled, the packet is queued until it can be sent.
The returned promise then settles for this packet only:
- resolve: DTLS send completed, or the packet was dropped by `stop()`,
  `replaceTrack(null)`, or pending-queue overflow
- reject: DTLS send threw while writing this packet

Later `sendRtp()` calls stay pending until their own packet is sent or
dropped, even if a drain is already in progress.

#### Parameters

##### rtp

`Buffer`\<`ArrayBufferLike`\> \| [`RtpPacket`](RtpPacket.md)

#### Returns

`Promise`\<`void`\>

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

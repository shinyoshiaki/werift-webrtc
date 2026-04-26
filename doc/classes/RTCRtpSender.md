[**werift**](../README.md) • **Docs**

***

[werift](../globals.md) / RTCRtpSender

# Class: RTCRtpSender

## Constructors

### new RTCRtpSender()

> **new RTCRtpSender**(`trackOrKind`): [`RTCRtpSender`](RTCRtpSender.md)

#### Parameters

• **trackOrKind**: [`Kind`](../type-aliases/Kind.md) \| [`MediaStreamTrack`](MediaStreamTrack.md)

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

### onGenericNack

> `readonly` **onGenericNack**: [`Event`](Event.md)\<[[`GenericNack`](GenericNack.md)]\>

***

### onPictureLossIndication

> `readonly` **onPictureLossIndication**: [`Event`](Event.md)\<[]\>

***

### onReady

> `readonly` **onReady**: [`Event`](Event.md)\<`any`[]\>

***

### onRtcp

> `readonly` **onRtcp**: [`Event`](Event.md)\<[[`RtcpPacket`](../type-aliases/RtcpPacket.md)]\>

***

### receiverEstimatedMaxBitrate

> **receiverEstimatedMaxBitrate**: `bigint`

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

### senderBWE

> `readonly` **senderBWE**: `SenderBandwidthEstimator`

***

### ssrc

> `readonly` **ssrc**: `number`

***

### stopped

> **stopped**: `boolean` = `false`

***

### streamId

> **streamId**: `string`

***

### track?

> `optional` **track**: [`MediaStreamTrack`](MediaStreamTrack.md)

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

> `get` **redDistance**(): `number`

> `set` **redDistance**(`n`): `void`

#### Parameters

• **n**: `number`

#### Returns

`number`

## Methods

### handleRtcpPacket()

> **handleRtcpPacket**(`rtcpPacket`): `void`

#### Parameters

• **rtcpPacket**: [`RtcpPacket`](../type-aliases/RtcpPacket.md)

#### Returns

`void`

***

### prepareSend()

> **prepareSend**(`params`): `void`

#### Parameters

• **params**: [`RTCRtpParameters`](../interfaces/RTCRtpParameters.md)

#### Returns

`void`

***

### registerTrack()

> **registerTrack**(`track`): `void`

#### Parameters

• **track**: [`MediaStreamTrack`](MediaStreamTrack.md)

#### Returns

`void`

***

### replaceRTP()

> **replaceRTP**(`__namedParameters`, `discontinuity`): `void`

#### Parameters

• **\_\_namedParameters**: `Pick`\<[`RtpHeader`](RtpHeader.md), `"sequenceNumber"` \| `"timestamp"`\>

• **discontinuity**: `boolean` = `false`

#### Returns

`void`

***

### replaceTrack()

> **replaceTrack**(`track`): `Promise`\<`void`\>

#### Parameters

• **track**: `null` \| [`MediaStreamTrack`](MediaStreamTrack.md)

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

• **rtp**: `Buffer` \| [`RtpPacket`](RtpPacket.md)

#### Returns

`Promise`\<`void`\>

***

### setDtlsTransport()

> **setDtlsTransport**(`dtlsTransport`): `void`

#### Parameters

• **dtlsTransport**: [`RTCDtlsTransport`](RTCDtlsTransport.md)

#### Returns

`void`

***

### stop()

> **stop**(): `void`

#### Returns

`void`

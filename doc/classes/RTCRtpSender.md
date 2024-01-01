[werift](../README.md) / [Exports](../modules.md) / RTCRtpSender

# Class: RTCRtpSender

## Table of contents

### Constructors

- [constructor](RTCRtpSender.md#constructor)

### Properties

- [codec](RTCRtpSender.md#codec)
- [dtlsTransport](RTCRtpSender.md#dtlstransport)
- [kind](RTCRtpSender.md#kind)
- [onGenericNack](RTCRtpSender.md#ongenericnack)
- [onPictureLossIndication](RTCRtpSender.md#onpicturelossindication)
- [onReady](RTCRtpSender.md#onready)
- [onRtcp](RTCRtpSender.md#onrtcp)
- [receiverEstimatedMaxBitrate](RTCRtpSender.md#receiverestimatedmaxbitrate)
- [redEncoder](RTCRtpSender.md#redencoder)
- [redRedundantPayloadType](RTCRtpSender.md#redredundantpayloadtype)
- [rtcpRunning](RTCRtpSender.md#rtcprunning)
- [rtxSsrc](RTCRtpSender.md#rtxssrc)
- [senderBWE](RTCRtpSender.md#senderbwe)
- [ssrc](RTCRtpSender.md#ssrc)
- [stopped](RTCRtpSender.md#stopped)
- [streamId](RTCRtpSender.md#streamid)
- [track](RTCRtpSender.md#track)
- [trackId](RTCRtpSender.md#trackid)
- [trackOrKind](RTCRtpSender.md#trackorkind)
- [type](RTCRtpSender.md#type)

### Accessors

- [redDistance](RTCRtpSender.md#reddistance)

### Methods

- [handleRtcpPacket](RTCRtpSender.md#handlertcppacket)
- [prepareSend](RTCRtpSender.md#preparesend)
- [registerTrack](RTCRtpSender.md#registertrack)
- [replaceRTP](RTCRtpSender.md#replacertp)
- [replaceTrack](RTCRtpSender.md#replacetrack)
- [runRtcp](RTCRtpSender.md#runrtcp)
- [sendRtp](RTCRtpSender.md#sendrtp)
- [setDtlsTransport](RTCRtpSender.md#setdtlstransport)
- [stop](RTCRtpSender.md#stop)

## Constructors

### constructor

• **new RTCRtpSender**(`trackOrKind`): [`RTCRtpSender`](RTCRtpSender.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `trackOrKind` | ``"unknown"`` \| ``"audio"`` \| ``"video"`` \| ``"application"`` \| [`MediaStreamTrack`](MediaStreamTrack.md) |

#### Returns

[`RTCRtpSender`](RTCRtpSender.md)

## Properties

### codec

• `Optional` **codec**: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)

___

### dtlsTransport

• **dtlsTransport**: [`RTCDtlsTransport`](RTCDtlsTransport.md)

___

### kind

• `Readonly` **kind**: [`Kind`](../modules.md#kind)

___

### onGenericNack

• `Readonly` **onGenericNack**: `Event`\<[[`GenericNack`](GenericNack.md)]\>

___

### onPictureLossIndication

• `Readonly` **onPictureLossIndication**: `Event`\<[]\>

___

### onReady

• `Readonly` **onReady**: `Event`\<`any`[]\>

___

### onRtcp

• `Readonly` **onRtcp**: `Event`\<[[`RtcpPacket`](../modules.md#rtcppacket)]\>

___

### receiverEstimatedMaxBitrate

• **receiverEstimatedMaxBitrate**: `bigint`

___

### redEncoder

• **redEncoder**: [`RedEncoder`](RedEncoder.md)

___

### redRedundantPayloadType

• `Optional` **redRedundantPayloadType**: `number`

___

### rtcpRunning

• **rtcpRunning**: `boolean` = `false`

___

### rtxSsrc

• `Readonly` **rtxSsrc**: `number`

___

### senderBWE

• `Readonly` **senderBWE**: `SenderBandwidthEstimator`

___

### ssrc

• `Readonly` **ssrc**: `number`

___

### stopped

• **stopped**: `boolean` = `false`

___

### streamId

• **streamId**: `string`

___

### track

• `Optional` **track**: [`MediaStreamTrack`](MediaStreamTrack.md)

___

### trackId

• `Readonly` **trackId**: `string`

___

### trackOrKind

• **trackOrKind**: ``"unknown"`` \| ``"audio"`` \| ``"video"`` \| ``"application"`` \| [`MediaStreamTrack`](MediaStreamTrack.md)

___

### type

• `Readonly` **type**: ``"sender"``

## Accessors

### redDistance

• `get` **redDistance**(): `number`

#### Returns

`number`

• `set` **redDistance**(`n`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `n` | `number` |

#### Returns

`void`

## Methods

### handleRtcpPacket

▸ **handleRtcpPacket**(`rtcpPacket`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `rtcpPacket` | [`RtcpPacket`](../modules.md#rtcppacket) |

#### Returns

`void`

___

### prepareSend

▸ **prepareSend**(`params`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `params` | [`RTCRtpParameters`](../interfaces/RTCRtpParameters.md) |

#### Returns

`void`

___

### registerTrack

▸ **registerTrack**(`track`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `track` | [`MediaStreamTrack`](MediaStreamTrack.md) |

#### Returns

`void`

___

### replaceRTP

▸ **replaceRTP**(`«destructured»`, `discontinuity?`): `void`

#### Parameters

| Name | Type | Default value |
| :------ | :------ | :------ |
| `«destructured»` | `Pick`\<[`RtpHeader`](RtpHeader.md), ``"sequenceNumber"`` \| ``"timestamp"``\> | `undefined` |
| `discontinuity` | `boolean` | `false` |

#### Returns

`void`

___

### replaceTrack

▸ **replaceTrack**(`track`): `Promise`\<`void`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `track` | ``null`` \| [`MediaStreamTrack`](MediaStreamTrack.md) |

#### Returns

`Promise`\<`void`\>

___

### runRtcp

▸ **runRtcp**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

___

### sendRtp

▸ **sendRtp**(`rtp`): `Promise`\<`void`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `rtp` | `Buffer` \| [`RtpPacket`](RtpPacket.md) |

#### Returns

`Promise`\<`void`\>

___

### setDtlsTransport

▸ **setDtlsTransport**(`dtlsTransport`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `dtlsTransport` | [`RTCDtlsTransport`](RTCDtlsTransport.md) |

#### Returns

`void`

___

### stop

▸ **stop**(): `void`

#### Returns

`void`

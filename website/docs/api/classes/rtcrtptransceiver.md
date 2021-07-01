---
id: "rtcrtptransceiver"
title: "Class: RTCRtpTransceiver"
sidebar_label: "RTCRtpTransceiver"
sidebar_position: 0
custom_edit_url: null
---

## Constructors

### constructor

• **new RTCRtpTransceiver**(`kind`, `receiver`, `sender`, `direction`, `dtlsTransport`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `kind` | [Kind](../modules.md#kind) |
| `receiver` | `RTCRtpReceiver` |
| `sender` | `RTCRtpSender` |
| `direction` | ``"inactive"`` \| ``"sendonly"`` \| ``"recvonly"`` \| ``"sendrecv"`` |
| `dtlsTransport` | [RTCDtlsTransport](rtcdtlstransport.md) |

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:49](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/media/rtpTransceiver.ts#L49)

## Properties

### \_codecs

• `Private` **\_codecs**: [RTCRtpCodecParameters](rtcrtpcodecparameters.md)[] = []

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:37](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/media/rtpTransceiver.ts#L37)

___

### \_currentDirection

• `Private` `Optional` **\_currentDirection**: ``"inactive"`` \| ``"sendonly"`` \| ``"recvonly"`` \| ``"sendrecv"`` \| ``"stopped"``

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:24](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/media/rtpTransceiver.ts#L24)

___

### direction

• **direction**: ``"inactive"`` \| ``"sendonly"`` \| ``"recvonly"`` \| ``"sendrecv"``

___

### dtlsTransport

• **dtlsTransport**: [RTCDtlsTransport](rtcdtlstransport.md)

___

### headerExtensions

• **headerExtensions**: [RTCRtpHeaderExtensionParameters](rtcrtpheaderextensionparameters.md)[] = []

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:46](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/media/rtpTransceiver.ts#L46)

___

### kind

• `Readonly` **kind**: [Kind](../modules.md#kind)

___

### mLineIndex

• `Optional` **mLineIndex**: `number`

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:22](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/media/rtpTransceiver.ts#L22)

___

### mid

• `Optional` **mid**: `string`

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:21](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/media/rtpTransceiver.ts#L21)

___

### offerDirection

• **offerDirection**: ``"inactive"`` \| ``"sendonly"`` \| ``"recvonly"`` \| ``"sendrecv"``

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:36](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/media/rtpTransceiver.ts#L36)

___

### onTrack

• `Readonly` **onTrack**: `default`<[[MediaStreamTrack](mediastreamtrack.md)]\>

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:20](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/media/rtpTransceiver.ts#L20)

___

### options

• **options**: `Partial`<[TransceiverOptions](../interfaces/transceiveroptions.md)\> = {}

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:47](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/media/rtpTransceiver.ts#L47)

___

### receiver

• `Readonly` **receiver**: `RTCRtpReceiver`

___

### sender

• `Readonly` **sender**: `RTCRtpSender`

___

### stopped

• **stopped**: `boolean` = false

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:49](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/media/rtpTransceiver.ts#L49)

___

### stopping

• **stopping**: `boolean` = false

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:48](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/media/rtpTransceiver.ts#L48)

___

### usedForSender

• **usedForSender**: `boolean` = false

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:23](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/media/rtpTransceiver.ts#L23)

___

### uuid

• `Readonly` **uuid**: `string`

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:19](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/media/rtpTransceiver.ts#L19)

## Accessors

### codecs

• `get` **codecs**(): [RTCRtpCodecParameters](rtcrtpcodecparameters.md)[]

#### Returns

[RTCRtpCodecParameters](rtcrtpcodecparameters.md)[]

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:38](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/media/rtpTransceiver.ts#L38)

• `set` **codecs**(`codecs`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `codecs` | [RTCRtpCodecParameters](rtcrtpcodecparameters.md)[] |

#### Returns

`void`

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:41](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/media/rtpTransceiver.ts#L41)

___

### currentDirection

• `get` **currentDirection**(): ``"inactive"`` \| ``"sendonly"`` \| ``"recvonly"`` \| ``"sendrecv"``

RFC 8829 4.2.5. last negotiated direction

#### Returns

``"inactive"`` \| ``"sendonly"`` \| ``"recvonly"`` \| ``"sendrecv"``

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:32](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/media/rtpTransceiver.ts#L32)

• `set` **currentDirection**(`direction`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `direction` | ``"inactive"`` \| ``"sendonly"`` \| ``"recvonly"`` \| ``"sendrecv"`` |

#### Returns

`void`

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:25](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/media/rtpTransceiver.ts#L25)

___

### msid

• `get` **msid**(): `string`

#### Returns

`string`

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:60](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/media/rtpTransceiver.ts#L60)

## Methods

### addTrack

▸ **addTrack**(`track`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `track` | [MediaStreamTrack](mediastreamtrack.md) |

#### Returns

`void`

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:64](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/media/rtpTransceiver.ts#L64)

___

### stop

▸ **stop**(): `void`

#### Returns

`void`

#### Defined in

[packages/webrtc/src/media/rtpTransceiver.ts:71](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/media/rtpTransceiver.ts#L71)

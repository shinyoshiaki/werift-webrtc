[werift](../README.md) / [Exports](../modules.md) / H264RtpPayload

# Class: H264RtpPayload

## Implements

- [`DePacketizerBase`](DePacketizerBase.md)

## Table of contents

### Constructors

- [constructor](H264RtpPayload.md#constructor)

### Properties

- [e](H264RtpPayload.md#e)
- [f](H264RtpPayload.md#f)
- [nalUnitPayloadType](H264RtpPayload.md#nalunitpayloadtype)
- [nalUnitType](H264RtpPayload.md#nalunittype)
- [nri](H264RtpPayload.md#nri)
- [payload](H264RtpPayload.md#payload)
- [r](H264RtpPayload.md#r)
- [s](H264RtpPayload.md#s)

### Accessors

- [isKeyframe](H264RtpPayload.md#iskeyframe)
- [isPartitionHead](H264RtpPayload.md#ispartitionhead)

### Methods

- [deSerialize](H264RtpPayload.md#deserialize)
- [isDetectedFinalPacketInSequence](H264RtpPayload.md#isdetectedfinalpacketinsequence)
- [packaging](H264RtpPayload.md#packaging)

## Constructors

### constructor

• **new H264RtpPayload**()

## Properties

### e

• **e**: `number`

end of a fragmented NAL unit

#### Defined in

[packages/rtp/src/codec/h264.ts:31](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/h264.ts#L31)

___

### f

• **f**: `number`

forbidden_zero_bit

#### Defined in

[packages/rtp/src/codec/h264.ts:23](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/h264.ts#L23)

___

### nalUnitPayloadType

• **nalUnitPayloadType**: `number`

#### Defined in

[packages/rtp/src/codec/h264.ts:33](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/h264.ts#L33)

___

### nalUnitType

• **nalUnitType**: `number`

nal_unit_types

#### Defined in

[packages/rtp/src/codec/h264.ts:27](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/h264.ts#L27)

___

### nri

• **nri**: `number`

nal_ref_idc

#### Defined in

[packages/rtp/src/codec/h264.ts:25](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/h264.ts#L25)

___

### payload

• **payload**: `Buffer`

#### Implementation of

[DePacketizerBase](DePacketizerBase.md).[payload](DePacketizerBase.md#payload)

#### Defined in

[packages/rtp/src/codec/h264.ts:34](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/h264.ts#L34)

___

### r

• **r**: `number`

#### Defined in

[packages/rtp/src/codec/h264.ts:32](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/h264.ts#L32)

___

### s

• **s**: `number`

start of a fragmented NAL unit

#### Defined in

[packages/rtp/src/codec/h264.ts:29](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/h264.ts#L29)

## Accessors

### isKeyframe

• `get` **isKeyframe**(): `boolean`

#### Returns

`boolean`

#### Implementation of

DePacketizerBase.isKeyframe

#### Defined in

[packages/rtp/src/codec/h264.ts:88](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/h264.ts#L88)

___

### isPartitionHead

• `get` **isPartitionHead**(): `boolean`

#### Returns

`boolean`

#### Defined in

[packages/rtp/src/codec/h264.ts:92](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/h264.ts#L92)

## Methods

### deSerialize

▸ `Static` **deSerialize**(`buf`): [`H264RtpPayload`](H264RtpPayload.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `buf` | `Buffer` |

#### Returns

[`H264RtpPayload`](H264RtpPayload.md)

#### Defined in

[packages/rtp/src/codec/h264.ts:36](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/h264.ts#L36)

___

### isDetectedFinalPacketInSequence

▸ `Static` **isDetectedFinalPacketInSequence**(`header`): `boolean`

#### Parameters

| Name | Type |
| :------ | :------ |
| `header` | [`RtpHeader`](RtpHeader.md) |

#### Returns

`boolean`

#### Defined in

[packages/rtp/src/codec/h264.ts:84](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/h264.ts#L84)

___

### packaging

▸ `Static` `Private` **packaging**(`buf`): `Buffer`

#### Parameters

| Name | Type |
| :------ | :------ |
| `buf` | `Buffer` |

#### Returns

`Buffer`

#### Defined in

[packages/rtp/src/codec/h264.ts:80](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/h264.ts#L80)

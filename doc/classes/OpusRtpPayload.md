[werift](../README.md) / [Exports](../modules.md) / OpusRtpPayload

# Class: OpusRtpPayload

## Implements

- [`DePacketizerBase`](DePacketizerBase.md)

## Table of contents

### Constructors

- [constructor](OpusRtpPayload.md#constructor)

### Properties

- [payload](OpusRtpPayload.md#payload)

### Accessors

- [isKeyframe](OpusRtpPayload.md#iskeyframe)

### Methods

- [createCodecPrivate](OpusRtpPayload.md#createcodecprivate)
- [deSerialize](OpusRtpPayload.md#deserialize)
- [isDetectedFinalPacketInSequence](OpusRtpPayload.md#isdetectedfinalpacketinsequence)

## Constructors

### constructor

• **new OpusRtpPayload**()

## Properties

### payload

• **payload**: `Buffer`

#### Implementation of

[DePacketizerBase](DePacketizerBase.md).[payload](DePacketizerBase.md#payload)

#### Defined in

[packages/rtp/src/codec/opus.ts:6](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/opus.ts#L6)

## Accessors

### isKeyframe

• `get` **isKeyframe**(): `boolean`

#### Returns

`boolean`

#### Implementation of

DePacketizerBase.isKeyframe

#### Defined in

[packages/rtp/src/codec/opus.ts:18](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/opus.ts#L18)

## Methods

### createCodecPrivate

▸ `Static` **createCodecPrivate**(`samplingFrequency?`): `Buffer`

#### Parameters

| Name | Type | Default value |
| :------ | :------ | :------ |
| `samplingFrequency` | `number` | `48000` |

#### Returns

`Buffer`

#### Defined in

[packages/rtp/src/codec/opus.ts:22](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/opus.ts#L22)

___

### deSerialize

▸ `Static` **deSerialize**(`buf`): [`OpusRtpPayload`](OpusRtpPayload.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `buf` | `Buffer` |

#### Returns

[`OpusRtpPayload`](OpusRtpPayload.md)

#### Defined in

[packages/rtp/src/codec/opus.ts:8](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/opus.ts#L8)

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

[packages/rtp/src/codec/opus.ts:14](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/opus.ts#L14)

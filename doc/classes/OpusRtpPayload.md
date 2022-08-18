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

## Accessors

### isKeyframe

• `get` **isKeyframe**(): `boolean`

#### Returns

`boolean`

#### Implementation of

DePacketizerBase.isKeyframe

## Methods

### createCodecPrivate

▸ `Static` **createCodecPrivate**(`samplingFrequency?`): `Buffer`

#### Parameters

| Name | Type | Default value |
| :------ | :------ | :------ |
| `samplingFrequency` | `number` | `48000` |

#### Returns

`Buffer`

___

### deSerialize

▸ `Static` **deSerialize**(`buf`): [`OpusRtpPayload`](OpusRtpPayload.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `buf` | `Buffer` |

#### Returns

[`OpusRtpPayload`](OpusRtpPayload.md)

___

### isDetectedFinalPacketInSequence

▸ `Static` **isDetectedFinalPacketInSequence**(`header`): `boolean`

#### Parameters

| Name | Type |
| :------ | :------ |
| `header` | [`RtpHeader`](RtpHeader.md) |

#### Returns

`boolean`

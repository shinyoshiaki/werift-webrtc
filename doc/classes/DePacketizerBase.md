[werift](../README.md) / [Exports](../modules.md) / DePacketizerBase

# Class: DePacketizerBase

## Implemented by

- [`H264RtpPayload`](H264RtpPayload.md)
- [`OpusRtpPayload`](OpusRtpPayload.md)
- [`Vp8RtpPayload`](Vp8RtpPayload.md)
- [`Vp9RtpPayload`](Vp9RtpPayload.md)

## Table of contents

### Constructors

- [constructor](DePacketizerBase.md#constructor)

### Properties

- [payload](DePacketizerBase.md#payload)

### Accessors

- [isKeyframe](DePacketizerBase.md#iskeyframe)

### Methods

- [deSerialize](DePacketizerBase.md#deserialize)
- [isDetectedFinalPacketInSequence](DePacketizerBase.md#isdetectedfinalpacketinsequence)

## Constructors

### constructor

• **new DePacketizerBase**()

## Properties

### payload

• **payload**: `Buffer`

## Accessors

### isKeyframe

• `get` **isKeyframe**(): `boolean`

#### Returns

`boolean`

## Methods

### deSerialize

▸ `Static` **deSerialize**(`buf`): [`DePacketizerBase`](DePacketizerBase.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `buf` | `Buffer` |

#### Returns

[`DePacketizerBase`](DePacketizerBase.md)

___

### isDetectedFinalPacketInSequence

▸ `Static` **isDetectedFinalPacketInSequence**(`header`): `boolean`

#### Parameters

| Name | Type |
| :------ | :------ |
| `header` | [`RtpHeader`](RtpHeader.md) |

#### Returns

`boolean`

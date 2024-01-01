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

- [fragment](DePacketizerBase.md#fragment)
- [payload](DePacketizerBase.md#payload)

### Accessors

- [isKeyframe](DePacketizerBase.md#iskeyframe)

### Methods

- [deSerialize](DePacketizerBase.md#deserialize)
- [isDetectedFinalPacketInSequence](DePacketizerBase.md#isdetectedfinalpacketinsequence)

## Constructors

### constructor

• **new DePacketizerBase**(): [`DePacketizerBase`](DePacketizerBase.md)

#### Returns

[`DePacketizerBase`](DePacketizerBase.md)

## Properties

### fragment

• `Optional` **fragment**: `Buffer`

___

### payload

• **payload**: `Buffer`

## Accessors

### isKeyframe

• `get` **isKeyframe**(): `boolean`

#### Returns

`boolean`

## Methods

### deSerialize

▸ **deSerialize**(`buf`, `fragment?`): [`DePacketizerBase`](DePacketizerBase.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `buf` | `Buffer` |
| `fragment?` | `Buffer` |

#### Returns

[`DePacketizerBase`](DePacketizerBase.md)

___

### isDetectedFinalPacketInSequence

▸ **isDetectedFinalPacketInSequence**(`header`): `boolean`

#### Parameters

| Name | Type |
| :------ | :------ |
| `header` | [`RtpHeader`](RtpHeader.md) |

#### Returns

`boolean`

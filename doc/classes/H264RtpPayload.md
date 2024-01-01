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
- [fragment](H264RtpPayload.md#fragment)
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

## Constructors

### constructor

• **new H264RtpPayload**(): [`H264RtpPayload`](H264RtpPayload.md)

#### Returns

[`H264RtpPayload`](H264RtpPayload.md)

## Properties

### e

• **e**: `number`

end of a fragmented NAL unit

___

### f

• **f**: `number`

forbidden_zero_bit

___

### fragment

• `Optional` **fragment**: `Buffer`

#### Implementation of

[DePacketizerBase](DePacketizerBase.md).[fragment](DePacketizerBase.md#fragment)

___

### nalUnitPayloadType

• **nalUnitPayloadType**: `number`

___

### nalUnitType

• **nalUnitType**: `number`

nal_unit_types

___

### nri

• **nri**: `number`

nal_ref_idc

___

### payload

• **payload**: `Buffer`

#### Implementation of

[DePacketizerBase](DePacketizerBase.md).[payload](DePacketizerBase.md#payload)

___

### r

• **r**: `number`

___

### s

• **s**: `number`

start of a fragmented NAL unit

## Accessors

### isKeyframe

• `get` **isKeyframe**(): `boolean`

#### Returns

`boolean`

#### Implementation of

DePacketizerBase.isKeyframe

___

### isPartitionHead

• `get` **isPartitionHead**(): `boolean`

#### Returns

`boolean`

## Methods

### deSerialize

▸ **deSerialize**(`buf`, `fragment?`): [`H264RtpPayload`](H264RtpPayload.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `buf` | `Buffer` |
| `fragment?` | `Buffer` |

#### Returns

[`H264RtpPayload`](H264RtpPayload.md)

___

### isDetectedFinalPacketInSequence

▸ **isDetectedFinalPacketInSequence**(`header`): `boolean`

#### Parameters

| Name | Type |
| :------ | :------ |
| `header` | [`RtpHeader`](RtpHeader.md) |

#### Returns

`boolean`

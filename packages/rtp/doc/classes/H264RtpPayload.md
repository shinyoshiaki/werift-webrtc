[werift-rtp](../README.md) / [Exports](../modules.md) / H264RtpPayload

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

## Constructors

### constructor

• **new H264RtpPayload**()

## Properties

### e

• **e**: `number`

end of a fragmented NAL unit

___

### f

• **f**: `number`

forbidden_zero_bit

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

▸ `Static` **deSerialize**(`buf`): [`H264RtpPayload`](H264RtpPayload.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `buf` | `Buffer` |

#### Returns

[`H264RtpPayload`](H264RtpPayload.md)

___

### isDetectedFinalPacketInSequence

▸ `Static` **isDetectedFinalPacketInSequence**(`header`): `boolean`

#### Parameters

| Name | Type |
| :------ | :------ |
| `header` | [`RtpHeader`](RtpHeader.md) |

#### Returns

`boolean`

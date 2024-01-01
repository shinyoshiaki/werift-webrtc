[werift-rtp](../README.md) / [Exports](../modules.md) / AV1Obu

# Class: AV1Obu

## Table of contents

### Constructors

- [constructor](AV1Obu.md#constructor)

### Properties

- [obu\_extension\_flag](AV1Obu.md#obu_extension_flag)
- [obu\_forbidden\_bit](AV1Obu.md#obu_forbidden_bit)
- [obu\_has\_size\_field](AV1Obu.md#obu_has_size_field)
- [obu\_reserved\_1bit](AV1Obu.md#obu_reserved_1bit)
- [obu\_type](AV1Obu.md#obu_type)
- [payload](AV1Obu.md#payload)

### Methods

- [serialize](AV1Obu.md#serialize)
- [deSerialize](AV1Obu.md#deserialize)

## Constructors

### constructor

• **new AV1Obu**(): [`AV1Obu`](AV1Obu.md)

#### Returns

[`AV1Obu`](AV1Obu.md)

## Properties

### obu\_extension\_flag

• **obu\_extension\_flag**: `number`

___

### obu\_forbidden\_bit

• **obu\_forbidden\_bit**: `number`

___

### obu\_has\_size\_field

• **obu\_has\_size\_field**: `number`

___

### obu\_reserved\_1bit

• **obu\_reserved\_1bit**: `number`

___

### obu\_type

• **obu\_type**: `OBU_TYPE`

___

### payload

• **payload**: `Buffer`

## Methods

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

___

### deSerialize

▸ **deSerialize**(`buf`): [`AV1Obu`](AV1Obu.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `buf` | `Buffer` |

#### Returns

[`AV1Obu`](AV1Obu.md)

[werift](../README.md) / [Exports](../modules.md) / AV1Obu

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

• **new AV1Obu**()

## Properties

### obu\_extension\_flag

• **obu\_extension\_flag**: `number`

#### Defined in

[packages/rtp/src/codec/av1.ts:191](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/av1.ts#L191)

___

### obu\_forbidden\_bit

• **obu\_forbidden\_bit**: `number`

#### Defined in

[packages/rtp/src/codec/av1.ts:189](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/av1.ts#L189)

___

### obu\_has\_size\_field

• **obu\_has\_size\_field**: `number`

#### Defined in

[packages/rtp/src/codec/av1.ts:192](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/av1.ts#L192)

___

### obu\_reserved\_1bit

• **obu\_reserved\_1bit**: `number`

#### Defined in

[packages/rtp/src/codec/av1.ts:193](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/av1.ts#L193)

___

### obu\_type

• **obu\_type**: `OBU_TYPE`

#### Defined in

[packages/rtp/src/codec/av1.ts:190](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/av1.ts#L190)

___

### payload

• **payload**: `Buffer`

#### Defined in

[packages/rtp/src/codec/av1.ts:194](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/av1.ts#L194)

## Methods

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

#### Defined in

[packages/rtp/src/codec/av1.ts:212](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/av1.ts#L212)

___

### deSerialize

▸ `Static` **deSerialize**(`buf`): [`AV1Obu`](AV1Obu.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `buf` | `Buffer` |

#### Returns

[`AV1Obu`](AV1Obu.md)

#### Defined in

[packages/rtp/src/codec/av1.ts:196](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/av1.ts#L196)

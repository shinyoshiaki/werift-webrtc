[werift-rtp](../README.md) / [Exports](../modules.md) / RtcpHeader

# Class: RtcpHeader

## Table of contents

### Constructors

- [constructor](RtcpHeader.md#constructor)

### Properties

- [count](RtcpHeader.md#count)
- [length](RtcpHeader.md#length)
- [padding](RtcpHeader.md#padding)
- [type](RtcpHeader.md#type)
- [version](RtcpHeader.md#version)

### Methods

- [serialize](RtcpHeader.md#serialize)
- [deSerialize](RtcpHeader.md#deserialize)

## Constructors

### constructor

• **new RtcpHeader**(`props?`): [`RtcpHeader`](RtcpHeader.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`\<[`RtcpHeader`](RtcpHeader.md)\> |

#### Returns

[`RtcpHeader`](RtcpHeader.md)

## Properties

### count

• **count**: `number` = `0`

___

### length

• **length**: `number` = `0`

このパケットの長さは、ヘッダーと任意のパディングを含む32ビットワードから 1を引いたものである

___

### padding

• **padding**: `boolean` = `false`

___

### type

• **type**: `number` = `0`

___

### version

• **version**: `number` = `2`

## Methods

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

___

### deSerialize

▸ **deSerialize**(`buf`): [`RtcpHeader`](RtcpHeader.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `buf` | `Buffer` |

#### Returns

[`RtcpHeader`](RtcpHeader.md)

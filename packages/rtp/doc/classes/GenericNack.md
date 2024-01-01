[werift-rtp](../README.md) / [Exports](../modules.md) / GenericNack

# Class: GenericNack

## Table of contents

### Constructors

- [constructor](GenericNack.md#constructor)

### Properties

- [count](GenericNack.md#count)
- [header](GenericNack.md#header)
- [lost](GenericNack.md#lost)
- [mediaSourceSsrc](GenericNack.md#mediasourcessrc)
- [senderSsrc](GenericNack.md#senderssrc)
- [count](GenericNack.md#count-1)

### Methods

- [serialize](GenericNack.md#serialize)
- [toJSON](GenericNack.md#tojson)
- [deSerialize](GenericNack.md#deserialize)

## Constructors

### constructor

• **new GenericNack**(`props?`): [`GenericNack`](GenericNack.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`\<[`GenericNack`](GenericNack.md)\> |

#### Returns

[`GenericNack`](GenericNack.md)

## Properties

### count

• `Readonly` **count**: `number` = `GenericNack.count`

___

### header

• **header**: [`RtcpHeader`](RtcpHeader.md)

___

### lost

• **lost**: `number`[] = `[]`

___

### mediaSourceSsrc

• **mediaSourceSsrc**: `number`

___

### senderSsrc

• **senderSsrc**: `number`

___

### count

▪ `Static` **count**: `number` = `1`

## Methods

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

___

### toJSON

▸ **toJSON**(): `Object`

#### Returns

`Object`

| Name | Type |
| :------ | :------ |
| `lost` | `number`[] |
| `mediaSourceSsrc` | `number` |
| `senderSsrc` | `number` |

___

### deSerialize

▸ **deSerialize**(`data`, `header`): [`GenericNack`](GenericNack.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |
| `header` | [`RtcpHeader`](RtcpHeader.md) |

#### Returns

[`GenericNack`](GenericNack.md)

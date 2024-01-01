[werift](../README.md) / [Exports](../modules.md) / PictureLossIndication

# Class: PictureLossIndication

## Table of contents

### Constructors

- [constructor](PictureLossIndication.md#constructor)

### Properties

- [count](PictureLossIndication.md#count)
- [length](PictureLossIndication.md#length)
- [mediaSsrc](PictureLossIndication.md#mediassrc)
- [senderSsrc](PictureLossIndication.md#senderssrc)
- [count](PictureLossIndication.md#count-1)

### Methods

- [serialize](PictureLossIndication.md#serialize)
- [deSerialize](PictureLossIndication.md#deserialize)

## Constructors

### constructor

• **new PictureLossIndication**(`props?`): [`PictureLossIndication`](PictureLossIndication.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`\<[`PictureLossIndication`](PictureLossIndication.md)\> |

#### Returns

[`PictureLossIndication`](PictureLossIndication.md)

## Properties

### count

• **count**: `number` = `PictureLossIndication.count`

___

### length

• **length**: `number` = `2`

___

### mediaSsrc

• **mediaSsrc**: `number`

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

### deSerialize

▸ **deSerialize**(`data`): [`PictureLossIndication`](PictureLossIndication.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |

#### Returns

[`PictureLossIndication`](PictureLossIndication.md)

[werift-rtp](../README.md) / [Exports](../modules.md) / RedEncoder

# Class: RedEncoder

## Table of contents

### Constructors

- [constructor](RedEncoder.md#constructor)

### Properties

- [cacheSize](RedEncoder.md#cachesize)
- [distance](RedEncoder.md#distance)

### Methods

- [build](RedEncoder.md#build)
- [push](RedEncoder.md#push)

## Constructors

### constructor

• **new RedEncoder**(`distance?`): [`RedEncoder`](RedEncoder.md)

#### Parameters

| Name | Type | Default value |
| :------ | :------ | :------ |
| `distance` | `number` | `1` |

#### Returns

[`RedEncoder`](RedEncoder.md)

## Properties

### cacheSize

• **cacheSize**: `number` = `10`

___

### distance

• **distance**: `number` = `1`

## Methods

### build

▸ **build**(): [`Red`](Red.md)

#### Returns

[`Red`](Red.md)

___

### push

▸ **push**(`payload`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `payload` | `Object` |
| `payload.block` | `Buffer` |
| `payload.blockPT` | `number` |
| `payload.timestamp` | `number` |

#### Returns

`void`

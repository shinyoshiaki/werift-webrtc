[werift-rtp](../README.md) / [Exports](../modules.md) / PromiseQueue

# Class: PromiseQueue

## Table of contents

### Constructors

- [constructor](PromiseQueue.md#constructor)

### Properties

- [queue](PromiseQueue.md#queue)
- [running](PromiseQueue.md#running)

### Methods

- [push](PromiseQueue.md#push)

## Constructors

### constructor

• **new PromiseQueue**()

## Properties

### queue

• **queue**: { `done`: (...`args`: `any`[]) => `void` ; `failed`: (...`args`: `any`[]) => `void` ; `promise`: () => `Promise`<`unknown`\>  }[] = `[]`

___

### running

• **running**: `boolean` = `false`

## Methods

### push

▸ **push**<`T`\>(`promise`): `Promise`<`T`\>

#### Type parameters

| Name |
| :------ |
| `T` |

#### Parameters

| Name | Type |
| :------ | :------ |
| `promise` | () => `Promise`<`T`\> |

#### Returns

`Promise`<`T`\>

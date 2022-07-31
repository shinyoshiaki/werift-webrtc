[werift](../README.md) / [Exports](../modules.md) / PromiseQueue

# Class: PromiseQueue

## Table of contents

### Constructors

- [constructor](PromiseQueue.md#constructor)

### Properties

- [queue](PromiseQueue.md#queue)
- [running](PromiseQueue.md#running)

### Methods

- [push](PromiseQueue.md#push)
- [run](PromiseQueue.md#run)

## Constructors

### constructor

• **new PromiseQueue**()

## Properties

### queue

• **queue**: { `done`: (...`args`: `any`[]) => `void` ; `failed`: (...`args`: `any`[]) => `void` ; `promise`: () => `Promise`<`unknown`\>  }[] = `[]`

#### Defined in

[packages/common/src/promise.ts:2](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/common/src/promise.ts#L2)

___

### running

• **running**: `boolean` = `false`

#### Defined in

[packages/common/src/promise.ts:7](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/common/src/promise.ts#L7)

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

#### Defined in

[packages/common/src/promise.ts:9](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/common/src/promise.ts#L9)

___

### run

▸ `Private` **run**(): `Promise`<`void`\>

#### Returns

`Promise`<`void`\>

#### Defined in

[packages/common/src/promise.ts:17](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/common/src/promise.ts#L17)

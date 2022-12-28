[werift-rtp](../README.md) / [Exports](../modules.md) / JitterBufferCallback

# Class: JitterBufferCallback

## Hierarchy

- [`JitterBufferBase`](JitterBufferBase.md)

  ↳ **`JitterBufferCallback`**

## Table of contents

### Constructors

- [constructor](JitterBufferCallback.md#constructor)

### Properties

- [clockRate](JitterBufferCallback.md#clockrate)

### Methods

- [input](JitterBufferCallback.md#input)
- [pipe](JitterBufferCallback.md#pipe)
- [processInput](JitterBufferCallback.md#processinput)

## Constructors

### constructor

• **new JitterBufferCallback**(`clockRate`, `options?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `clockRate` | `number` |
| `options` | `Partial`<[`JitterBufferOptions`](../interfaces/JitterBufferOptions.md)\> |

#### Overrides

[JitterBufferBase](JitterBufferBase.md).[constructor](JitterBufferBase.md#constructor)

## Properties

### clockRate

• **clockRate**: `number`

#### Inherited from

[JitterBufferBase](JitterBufferBase.md).[clockRate](JitterBufferBase.md#clockrate)

## Methods

### input

▸ **input**(`input`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `input` | [`RtpOutput`](../interfaces/RtpOutput.md) |

#### Returns

`void`

___

### pipe

▸ **pipe**(`cb`): `this`

#### Parameters

| Name | Type |
| :------ | :------ |
| `cb` | (`input`: [`JitterBufferOutput`](../interfaces/JitterBufferOutput.md)) => `void` |

#### Returns

`this`

___

### processInput

▸ **processInput**(`input`): [`JitterBufferOutput`](../interfaces/JitterBufferOutput.md)[]

#### Parameters

| Name | Type |
| :------ | :------ |
| `input` | [`RtpOutput`](../interfaces/RtpOutput.md) |

#### Returns

[`JitterBufferOutput`](../interfaces/JitterBufferOutput.md)[]

#### Inherited from

[JitterBufferBase](JitterBufferBase.md).[processInput](JitterBufferBase.md#processinput)

[werift-rtp](../README.md) / [Exports](../modules.md) / JitterBufferTransformer

# Class: JitterBufferTransformer

## Hierarchy

- [`JitterBufferBase`](JitterBufferBase.md)

  ↳ **`JitterBufferTransformer`**

## Table of contents

### Constructors

- [constructor](JitterBufferTransformer.md#constructor)

### Properties

- [clockRate](JitterBufferTransformer.md#clockrate)
- [transform](JitterBufferTransformer.md#transform)

### Methods

- [processInput](JitterBufferTransformer.md#processinput)

## Constructors

### constructor

• **new JitterBufferTransformer**(`clockRate`, `options?`)

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

___

### transform

• **transform**: `TransformStream`<[`RtpOutput`](../interfaces/RtpOutput.md), [`JitterBufferOutput`](../interfaces/JitterBufferOutput.md)\>

## Methods

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

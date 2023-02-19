[werift](../README.md) / [Exports](../modules.md) / JitterBufferBase

# Class: JitterBufferBase

## Hierarchy

- **`JitterBufferBase`**

  ↳ [`JitterBufferCallback`](JitterBufferCallback.md)

  ↳ [`JitterBufferTransformer`](JitterBufferTransformer.md)

## Implements

- `Processor`<[`JitterBufferInput`](../modules.md#jitterbufferinput), [`JitterBufferOutput`](../interfaces/JitterBufferOutput.md)\>

## Table of contents

### Constructors

- [constructor](JitterBufferBase.md#constructor)

### Properties

- [clockRate](JitterBufferBase.md#clockrate)

### Methods

- [processInput](JitterBufferBase.md#processinput)

## Constructors

### constructor

• **new JitterBufferBase**(`clockRate`, `options?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `clockRate` | `number` |
| `options` | `Partial`<[`JitterBufferOptions`](../interfaces/JitterBufferOptions.md)\> |

## Properties

### clockRate

• **clockRate**: `number`

## Methods

### processInput

▸ **processInput**(`input`): [`JitterBufferOutput`](../interfaces/JitterBufferOutput.md)[]

#### Parameters

| Name | Type |
| :------ | :------ |
| `input` | [`RtpOutput`](../interfaces/RtpOutput.md) |

#### Returns

[`JitterBufferOutput`](../interfaces/JitterBufferOutput.md)[]

#### Implementation of

Processor.processInput

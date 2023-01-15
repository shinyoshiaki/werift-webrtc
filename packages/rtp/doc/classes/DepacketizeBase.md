[werift-rtp](../README.md) / [Exports](../modules.md) / DepacketizeBase

# Class: DepacketizeBase

## Hierarchy

- **`DepacketizeBase`**

  ↳ [`DepacketizeCallback`](DepacketizeCallback.md)

## Implements

- `Processor`<[`DepacketizerInput`](../modules.md#depacketizerinput), [`DepacketizerOutput`](../interfaces/DepacketizerOutput.md)\>

## Table of contents

### Constructors

- [constructor](DepacketizeBase.md#constructor)

### Properties

- [sequence](DepacketizeBase.md#sequence)

### Methods

- [processInput](DepacketizeBase.md#processinput)

## Constructors

### constructor

• **new DepacketizeBase**(`codec`, `options?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `codec` | `string` |
| `options` | `Object` |
| `options.isFinalPacketInSequence?` | (`header`: [`RtpHeader`](RtpHeader.md)) => `boolean` |

## Properties

### sequence

• **sequence**: `number` = `0`

## Methods

### processInput

▸ **processInput**(`input`): [`DepacketizerOutput`](../interfaces/DepacketizerOutput.md)[]

#### Parameters

| Name | Type |
| :------ | :------ |
| `input` | [`DepacketizerInput`](../modules.md#depacketizerinput) |

#### Returns

[`DepacketizerOutput`](../interfaces/DepacketizerOutput.md)[]

#### Implementation of

Processor.processInput

[werift](../README.md) / [Exports](../modules.md) / DepacketizeCallback

# Class: DepacketizeCallback

## Hierarchy

- [`DepacketizeBase`](DepacketizeBase.md)

  ↳ **`DepacketizeCallback`**

## Table of contents

### Constructors

- [constructor](DepacketizeCallback.md#constructor)

### Properties

- [sequence](DepacketizeCallback.md#sequence)

### Methods

- [input](DepacketizeCallback.md#input)
- [pipe](DepacketizeCallback.md#pipe)
- [processInput](DepacketizeCallback.md#processinput)

## Constructors

### constructor

• **new DepacketizeCallback**(`codec`, `options?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `codec` | `string` |
| `options` | `Object` |
| `options.isFinalPacketInSequence?` | (`header`: [`RtpHeader`](RtpHeader.md)) => `boolean` |
| `options.waitForKeyframe?` | `boolean` |

#### Overrides

[DepacketizeBase](DepacketizeBase.md).[constructor](DepacketizeBase.md#constructor)

## Properties

### sequence

• **sequence**: `number` = `0`

#### Inherited from

[DepacketizeBase](DepacketizeBase.md).[sequence](DepacketizeBase.md#sequence)

## Methods

### input

▸ **input**(`input`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `input` | [`DepacketizerInput`](../modules.md#depacketizerinput) |

#### Returns

`void`

___

### pipe

▸ **pipe**(`cb`): `this`

#### Parameters

| Name | Type |
| :------ | :------ |
| `cb` | (`input`: [`DepacketizerOutput`](../interfaces/DepacketizerOutput.md)) => `void` |

#### Returns

`this`

___

### processInput

▸ **processInput**(`input`): [`DepacketizerOutput`](../interfaces/DepacketizerOutput.md)[]

#### Parameters

| Name | Type |
| :------ | :------ |
| `input` | [`DepacketizerInput`](../modules.md#depacketizerinput) |

#### Returns

[`DepacketizerOutput`](../interfaces/DepacketizerOutput.md)[]

#### Inherited from

[DepacketizeBase](DepacketizeBase.md).[processInput](DepacketizeBase.md#processinput)

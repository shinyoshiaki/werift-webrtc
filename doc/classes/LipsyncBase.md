[werift](../README.md) / [Exports](../modules.md) / LipsyncBase

# Class: LipsyncBase

## Hierarchy

- **`LipsyncBase`**

  ↳ [`LipsyncCallback`](LipsyncCallback.md)

## Implements

- `AVProcessor`<[`LipsyncInput`](../modules.md#lipsyncinput)\>

## Table of contents

### Constructors

- [constructor](LipsyncBase.md#constructor)

### Properties

- [audioBuffer](LipsyncBase.md#audiobuffer)
- [baseTime](LipsyncBase.md#basetime)
- [bufferLength](LipsyncBase.md#bufferlength)
- [lastCommited](LipsyncBase.md#lastcommited)
- [stopped](LipsyncBase.md#stopped)
- [videoBuffer](LipsyncBase.md#videobuffer)

### Methods

- [processAudioInput](LipsyncBase.md#processaudioinput)
- [processVideoInput](LipsyncBase.md#processvideoinput)

## Constructors

### constructor

• **new LipsyncBase**(`audioOutput`, `videoOutput`, `options?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `audioOutput` | (`output`: [`LipsyncOutput`](../modules.md#lipsyncoutput)) => `void` |
| `videoOutput` | (`output`: [`LipsyncOutput`](../modules.md#lipsyncoutput)) => `void` |
| `options` | `Partial`<[`LipSyncOptions`](../interfaces/LipSyncOptions.md)\> |

## Properties

### audioBuffer

• **audioBuffer**: [`LipsyncInput`](../modules.md#lipsyncinput) & { `[key: string]`: `any`; `elapsed`: `number` ; `kind`: `string`  }[][]

___

### baseTime

• `Optional` **baseTime**: `number`

ms

___

### bufferLength

• **bufferLength**: `number`

___

### lastCommited

• **lastCommited**: `number` = `0`

ms

___

### stopped

• **stopped**: `boolean` = `false`

___

### videoBuffer

• **videoBuffer**: [`LipsyncInput`](../modules.md#lipsyncinput) & { `[key: string]`: `any`; `elapsed`: `number` ; `kind`: `string`  }[][]

## Methods

### processAudioInput

▸ **processAudioInput**(`«destructured»`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `«destructured»` | [`LipsyncInput`](../modules.md#lipsyncinput) |

#### Returns

`void`

#### Implementation of

AVProcessor.processAudioInput

___

### processVideoInput

▸ **processVideoInput**(`«destructured»`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `«destructured»` | [`LipsyncInput`](../modules.md#lipsyncinput) |

#### Returns

`void`

#### Implementation of

AVProcessor.processVideoInput

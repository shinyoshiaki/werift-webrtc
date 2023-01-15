[werift-rtp](../README.md) / [Exports](../modules.md) / LipsyncCallback

# Class: LipsyncCallback

## Hierarchy

- [`LipsyncBase`](LipsyncBase.md)

  ↳ **`LipsyncCallback`**

## Table of contents

### Constructors

- [constructor](LipsyncCallback.md#constructor)

### Properties

- [audioBuffer](LipsyncCallback.md#audiobuffer)
- [baseTime](LipsyncCallback.md#basetime)
- [bufferLength](LipsyncCallback.md#bufferlength)
- [inputAudio](LipsyncCallback.md#inputaudio)
- [inputVideo](LipsyncCallback.md#inputvideo)
- [lastCommited](LipsyncCallback.md#lastcommited)
- [stopped](LipsyncCallback.md#stopped)
- [videoBuffer](LipsyncCallback.md#videobuffer)

### Methods

- [pipeAudio](LipsyncCallback.md#pipeaudio)
- [pipeVideo](LipsyncCallback.md#pipevideo)
- [processAudioInput](LipsyncCallback.md#processaudioinput)
- [processVideoInput](LipsyncCallback.md#processvideoinput)

## Constructors

### constructor

• **new LipsyncCallback**(`options?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `options` | `Partial`<[`LipSyncOptions`](../interfaces/LipSyncOptions.md)\> |

#### Overrides

[LipsyncBase](LipsyncBase.md).[constructor](LipsyncBase.md#constructor)

## Properties

### audioBuffer

• **audioBuffer**: [`LipsyncInput`](../modules.md#lipsyncinput) & { `[key: string]`: `any`; `elapsed`: `number` ; `kind`: `string`  }[][]

#### Inherited from

[LipsyncBase](LipsyncBase.md).[audioBuffer](LipsyncBase.md#audiobuffer)

___

### baseTime

• `Optional` **baseTime**: `number`

ms

#### Inherited from

[LipsyncBase](LipsyncBase.md).[baseTime](LipsyncBase.md#basetime)

___

### bufferLength

• **bufferLength**: `number`

#### Inherited from

[LipsyncBase](LipsyncBase.md).[bufferLength](LipsyncBase.md#bufferlength)

___

### inputAudio

• **inputAudio**: (`__namedParameters`: [`LipsyncInput`](../modules.md#lipsyncinput)) => `void`

#### Type declaration

▸ (`«destructured»`): `void`

##### Parameters

| Name | Type |
| :------ | :------ |
| `«destructured»` | [`LipsyncInput`](../modules.md#lipsyncinput) |

##### Returns

`void`

___

### inputVideo

• **inputVideo**: (`__namedParameters`: [`LipsyncInput`](../modules.md#lipsyncinput)) => `void`

#### Type declaration

▸ (`«destructured»`): `void`

##### Parameters

| Name | Type |
| :------ | :------ |
| `«destructured»` | [`LipsyncInput`](../modules.md#lipsyncinput) |

##### Returns

`void`

___

### lastCommited

• **lastCommited**: `number` = `0`

ms

#### Inherited from

[LipsyncBase](LipsyncBase.md).[lastCommited](LipsyncBase.md#lastcommited)

___

### stopped

• **stopped**: `boolean` = `false`

#### Inherited from

[LipsyncBase](LipsyncBase.md).[stopped](LipsyncBase.md#stopped)

___

### videoBuffer

• **videoBuffer**: [`LipsyncInput`](../modules.md#lipsyncinput) & { `[key: string]`: `any`; `elapsed`: `number` ; `kind`: `string`  }[][]

#### Inherited from

[LipsyncBase](LipsyncBase.md).[videoBuffer](LipsyncBase.md#videobuffer)

## Methods

### pipeAudio

▸ **pipeAudio**(`cb`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `cb` | (`input`: [`LipsyncOutput`](../modules.md#lipsyncoutput)) => `void` |

#### Returns

`void`

___

### pipeVideo

▸ **pipeVideo**(`cb`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `cb` | (`input`: [`LipsyncOutput`](../modules.md#lipsyncoutput)) => `void` |

#### Returns

`void`

___

### processAudioInput

▸ **processAudioInput**(`«destructured»`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `«destructured»` | [`LipsyncInput`](../modules.md#lipsyncinput) |

#### Returns

`void`

#### Inherited from

[LipsyncBase](LipsyncBase.md).[processAudioInput](LipsyncBase.md#processaudioinput)

___

### processVideoInput

▸ **processVideoInput**(`«destructured»`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `«destructured»` | [`LipsyncInput`](../modules.md#lipsyncinput) |

#### Returns

`void`

#### Inherited from

[LipsyncBase](LipsyncBase.md).[processVideoInput](LipsyncBase.md#processvideoinput)

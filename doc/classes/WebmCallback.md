[werift](../README.md) / [Exports](../modules.md) / WebmCallback

# Class: WebmCallback

## Hierarchy

- [`WebmBase`](WebmBase.md)

  ↳ **`WebmCallback`**

## Table of contents

### Constructors

- [constructor](WebmCallback.md#constructor)

### Properties

- [elapsed](WebmCallback.md#elapsed)
- [inputAudio](WebmCallback.md#inputaudio)
- [inputVideo](WebmCallback.md#inputvideo)
- [stopped](WebmCallback.md#stopped)
- [tracks](WebmCallback.md#tracks)

### Methods

- [pipe](WebmCallback.md#pipe)
- [processAudioInput](WebmCallback.md#processaudioinput)
- [processVideoInput](WebmCallback.md#processvideoinput)
- [start](WebmCallback.md#start)

## Constructors

### constructor

• **new WebmCallback**(`tracks`, `options?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `tracks` | { `clockRate`: `number` ; `codec`: ``"AV1"`` \| ``"MPEG4/ISO/AVC"`` \| ``"VP8"`` \| ``"VP9"`` \| ``"OPUS"`` ; `height?`: `number` ; `kind`: ``"audio"`` \| ``"video"`` ; `trackNumber`: `number` ; `width?`: `number`  }[] |
| `options` | [`WebmOption`](../interfaces/WebmOption.md) |

#### Overrides

[WebmBase](WebmBase.md).[constructor](WebmBase.md#constructor)

## Properties

### elapsed

• `Optional` **elapsed**: `number`

#### Inherited from

[WebmBase](WebmBase.md).[elapsed](WebmBase.md#elapsed)

___

### inputAudio

• **inputAudio**: (`input`: [`DepacketizerOutput`](../interfaces/DepacketizerOutput.md)) => `void`

#### Type declaration

▸ (`input`): `void`

##### Parameters

| Name | Type |
| :------ | :------ |
| `input` | [`DepacketizerOutput`](../interfaces/DepacketizerOutput.md) |

##### Returns

`void`

___

### inputVideo

• **inputVideo**: (`input`: [`DepacketizerOutput`](../interfaces/DepacketizerOutput.md)) => `void`

#### Type declaration

▸ (`input`): `void`

##### Parameters

| Name | Type |
| :------ | :------ |
| `input` | [`DepacketizerOutput`](../interfaces/DepacketizerOutput.md) |

##### Returns

`void`

___

### stopped

• **stopped**: `boolean` = `false`

#### Inherited from

[WebmBase](WebmBase.md).[stopped](WebmBase.md#stopped)

___

### tracks

• **tracks**: { `clockRate`: `number` ; `codec`: ``"AV1"`` \| ``"MPEG4/ISO/AVC"`` \| ``"VP8"`` \| ``"VP9"`` \| ``"OPUS"`` ; `height?`: `number` ; `kind`: ``"audio"`` \| ``"video"`` ; `trackNumber`: `number` ; `width?`: `number`  }[]

#### Inherited from

[WebmBase](WebmBase.md).[tracks](WebmBase.md#tracks)

## Methods

### pipe

▸ **pipe**(`cb`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `cb` | (`input`: [`WebmOutput`](../modules.md#webmoutput)) => `void` |

#### Returns

`void`

___

### processAudioInput

▸ **processAudioInput**(`input`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `input` | [`DepacketizerOutput`](../interfaces/DepacketizerOutput.md) |

#### Returns

`void`

#### Inherited from

[WebmBase](WebmBase.md).[processAudioInput](WebmBase.md#processaudioinput)

___

### processVideoInput

▸ **processVideoInput**(`input`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `input` | [`DepacketizerOutput`](../interfaces/DepacketizerOutput.md) |

#### Returns

`void`

#### Inherited from

[WebmBase](WebmBase.md).[processVideoInput](WebmBase.md#processvideoinput)

___

### start

▸ **start**(): `void`

#### Returns

`void`

#### Inherited from

[WebmBase](WebmBase.md).[start](WebmBase.md#start)

[werift](../README.md) / [Exports](../modules.md) / WebmBase

# Class: WebmBase

## Hierarchy

- **`WebmBase`**

  ↳ [`WebmCallback`](WebmCallback.md)

  ↳ [`WebmStream`](WebmStream.md)

## Table of contents

### Constructors

- [constructor](WebmBase.md#constructor)

### Properties

- [elapsed](WebmBase.md#elapsed)
- [stopped](WebmBase.md#stopped)
- [tracks](WebmBase.md#tracks)

### Methods

- [processAudioInput](WebmBase.md#processaudioinput)
- [processVideoInput](WebmBase.md#processvideoinput)
- [start](WebmBase.md#start)

## Constructors

### constructor

• **new WebmBase**(`tracks`, `output`, `options?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `tracks` | { `clockRate`: `number` ; `codec`: ``"AV1"`` \| ``"MPEG4/ISO/AVC"`` \| ``"VP8"`` \| ``"VP9"`` \| ``"OPUS"`` ; `height?`: `number` ; `kind`: ``"audio"`` \| ``"video"`` ; `trackNumber`: `number` ; `width?`: `number`  }[] |
| `output` | (`output`: [`WebmOutput`](../modules.md#webmoutput)) => `void` |
| `options` | [`WebmOption`](../interfaces/WebmOption.md) |

## Properties

### elapsed

• `Optional` **elapsed**: `number`

___

### stopped

• **stopped**: `boolean` = `false`

___

### tracks

• **tracks**: { `clockRate`: `number` ; `codec`: ``"AV1"`` \| ``"MPEG4/ISO/AVC"`` \| ``"VP8"`` \| ``"VP9"`` \| ``"OPUS"`` ; `height?`: `number` ; `kind`: ``"audio"`` \| ``"video"`` ; `trackNumber`: `number` ; `width?`: `number`  }[]

## Methods

### processAudioInput

▸ **processAudioInput**(`input`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `input` | [`DepacketizerOutput`](../interfaces/DepacketizerOutput.md) |

#### Returns

`void`

___

### processVideoInput

▸ **processVideoInput**(`input`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `input` | [`DepacketizerOutput`](../interfaces/DepacketizerOutput.md) |

#### Returns

`void`

___

### start

▸ **start**(): `void`

#### Returns

`void`

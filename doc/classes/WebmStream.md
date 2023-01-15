[werift](../README.md) / [Exports](../modules.md) / WebmStream

# Class: WebmStream

## Hierarchy

- [`WebmBase`](WebmBase.md)

  ↳ **`WebmStream`**

## Table of contents

### Constructors

- [constructor](WebmStream.md#constructor)

### Properties

- [audioStream](WebmStream.md#audiostream)
- [elapsed](WebmStream.md#elapsed)
- [stopped](WebmStream.md#stopped)
- [tracks](WebmStream.md#tracks)
- [videoStream](WebmStream.md#videostream)
- [webmStream](WebmStream.md#webmstream)

### Methods

- [processAudioInput](WebmStream.md#processaudioinput)
- [processVideoInput](WebmStream.md#processvideoinput)
- [start](WebmStream.md#start)

## Constructors

### constructor

• **new WebmStream**(`tracks`, `options?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `tracks` | { `clockRate`: `number` ; `codec`: ``"AV1"`` \| ``"MPEG4/ISO/AVC"`` \| ``"VP8"`` \| ``"VP9"`` \| ``"OPUS"`` ; `height?`: `number` ; `kind`: ``"audio"`` \| ``"video"`` ; `trackNumber`: `number` ; `width?`: `number`  }[] |
| `options` | [`WebmOption`](../interfaces/WebmOption.md) |

#### Overrides

[WebmBase](WebmBase.md).[constructor](WebmBase.md#constructor)

## Properties

### audioStream

• **audioStream**: `WritableStream`<[`WebmInput`](../modules.md#webminput)\>

___

### elapsed

• `Optional` **elapsed**: `number`

#### Inherited from

[WebmBase](WebmBase.md).[elapsed](WebmBase.md#elapsed)

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

___

### videoStream

• **videoStream**: `WritableStream`<[`WebmInput`](../modules.md#webminput)\>

___

### webmStream

• **webmStream**: `ReadableStream`<[`WebmOutput`](../modules.md#webmoutput)\>

## Methods

### processAudioInput

▸ **processAudioInput**(`input`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `input` | [`WebmInput`](../modules.md#webminput) |

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
| `input` | [`WebmInput`](../modules.md#webminput) |

#### Returns

`void`

#### Inherited from

[WebmBase](WebmBase.md).[processVideoInput](WebmBase.md#processvideoinput)

___

### start

▸ `Protected` **start**(): `void`

#### Returns

`void`

#### Inherited from

[WebmBase](WebmBase.md).[start](WebmBase.md#start)

[werift](../README.md) / [Exports](../modules.md) / AvBufferCallback

# Class: AvBufferCallback

**`Description`**

[japanese]
audioパケットとvideoパケットを同一のタイムラインで扱い、それぞれの
パケットのタイムスタンプが前後しないように制御する

## Hierarchy

- [`AVBufferBase`](AVBufferBase.md)

  ↳ **`AvBufferCallback`**

## Table of contents

### Constructors

- [constructor](AvBufferCallback.md#constructor)

### Properties

- [audioBuffer](AvBufferCallback.md#audiobuffer)
- [baseAudioTimestamp](AvBufferCallback.md#baseaudiotimestamp)
- [baseVideoTimestamp](AvBufferCallback.md#basevideotimestamp)
- [bufferLength](AvBufferCallback.md#bufferlength)
- [inputAudio](AvBufferCallback.md#inputaudio)
- [inputVideo](AvBufferCallback.md#inputvideo)
- [stopped](AvBufferCallback.md#stopped)
- [videoBuffer](AvBufferCallback.md#videobuffer)

### Methods

- [pipeAudio](AvBufferCallback.md#pipeaudio)
- [pipeVideo](AvBufferCallback.md#pipevideo)
- [processAudioInput](AvBufferCallback.md#processaudioinput)
- [processVideoInput](AvBufferCallback.md#processvideoinput)

## Constructors

### constructor

• **new AvBufferCallback**(`options?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `options` | `Partial`<[`AvBufferOptions`](../interfaces/AvBufferOptions.md)\> |

#### Overrides

[AVBufferBase](AVBufferBase.md).[constructor](AVBufferBase.md#constructor)

## Properties

### audioBuffer

• **audioBuffer**: [`DepacketizerOutput`](../interfaces/DepacketizerOutput.md) & { `elapsed`: `number` ; `kind`: `string`  }[][]

#### Inherited from

[AVBufferBase](AVBufferBase.md).[audioBuffer](AVBufferBase.md#audiobuffer)

___

### baseAudioTimestamp

• `Optional` **baseAudioTimestamp**: `number`

#### Inherited from

[AVBufferBase](AVBufferBase.md).[baseAudioTimestamp](AVBufferBase.md#baseaudiotimestamp)

___

### baseVideoTimestamp

• `Optional` **baseVideoTimestamp**: `number`

#### Inherited from

[AVBufferBase](AVBufferBase.md).[baseVideoTimestamp](AVBufferBase.md#basevideotimestamp)

___

### bufferLength

• **bufferLength**: `number`

#### Inherited from

[AVBufferBase](AVBufferBase.md).[bufferLength](AVBufferBase.md#bufferlength)

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

[AVBufferBase](AVBufferBase.md).[stopped](AVBufferBase.md#stopped)

___

### videoBuffer

• **videoBuffer**: [`DepacketizerOutput`](../interfaces/DepacketizerOutput.md) & { `elapsed`: `number` ; `kind`: `string`  }[][]

#### Inherited from

[AVBufferBase](AVBufferBase.md).[videoBuffer](AVBufferBase.md#videobuffer)

## Methods

### pipeAudio

▸ **pipeAudio**(`cb`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `cb` | (`input`: [`DepacketizerOutput`](../interfaces/DepacketizerOutput.md)) => `void` |

#### Returns

`void`

___

### pipeVideo

▸ **pipeVideo**(`cb`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `cb` | (`input`: [`DepacketizerOutput`](../interfaces/DepacketizerOutput.md)) => `void` |

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

[AVBufferBase](AVBufferBase.md).[processAudioInput](AVBufferBase.md#processaudioinput)

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

[AVBufferBase](AVBufferBase.md).[processVideoInput](AVBufferBase.md#processvideoinput)

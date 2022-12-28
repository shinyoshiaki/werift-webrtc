[werift](../README.md) / [Exports](../modules.md) / AVBufferBase

# Class: AVBufferBase

**`Description`**

[japanese]
audioパケットとvideoパケットを同一のタイムラインで扱い、それぞれの
パケットのタイムスタンプが前後しないように制御する

## Hierarchy

- **`AVBufferBase`**

  ↳ [`AvBufferCallback`](AvBufferCallback.md)

## Table of contents

### Constructors

- [constructor](AVBufferBase.md#constructor)

### Properties

- [audioBuffer](AVBufferBase.md#audiobuffer)
- [baseAudioTimestamp](AVBufferBase.md#baseaudiotimestamp)
- [baseVideoTimestamp](AVBufferBase.md#basevideotimestamp)
- [bufferLength](AVBufferBase.md#bufferlength)
- [stopped](AVBufferBase.md#stopped)
- [videoBuffer](AVBufferBase.md#videobuffer)

### Methods

- [processAudioInput](AVBufferBase.md#processaudioinput)
- [processVideoInput](AVBufferBase.md#processvideoinput)

## Constructors

### constructor

• **new AVBufferBase**(`audioOutput`, `videoOutput`, `options?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `audioOutput` | (`output`: [`DepacketizerOutput`](../interfaces/DepacketizerOutput.md)) => `void` |
| `videoOutput` | (`output`: [`DepacketizerOutput`](../interfaces/DepacketizerOutput.md)) => `void` |
| `options` | `Partial`<[`AvBufferOptions`](../interfaces/AvBufferOptions.md)\> |

## Properties

### audioBuffer

• **audioBuffer**: [`DepacketizerOutput`](../interfaces/DepacketizerOutput.md) & { `elapsed`: `number` ; `kind`: `string`  }[][]

___

### baseAudioTimestamp

• `Optional` **baseAudioTimestamp**: `number`

___

### baseVideoTimestamp

• `Optional` **baseVideoTimestamp**: `number`

___

### bufferLength

• **bufferLength**: `number`

___

### stopped

• **stopped**: `boolean` = `false`

___

### videoBuffer

• **videoBuffer**: [`DepacketizerOutput`](../interfaces/DepacketizerOutput.md) & { `elapsed`: `number` ; `kind`: `string`  }[][]

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

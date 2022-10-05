[werift](../README.md) / [Exports](../modules.md) / WebmLiveSink

# Class: WebmLiveSink

## Table of contents

### Constructors

- [constructor](WebmLiveSink.md#constructor)

### Properties

- [audioStream](WebmLiveSink.md#audiostream)
- [stopped](WebmLiveSink.md#stopped)
- [tracks](WebmLiveSink.md#tracks)
- [videoStream](WebmLiveSink.md#videostream)
- [webmStream](WebmLiveSink.md#webmstream)

## Constructors

### constructor

• **new WebmLiveSink**(`tracks`, `options?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `tracks` | { `clockRate`: `number` ; `codec`: ``"AV1"`` \| ``"MPEG4/ISO/AVC"`` \| ``"VP8"`` \| ``"VP9"`` \| ``"OPUS"`` ; `height?`: `number` ; `kind`: ``"audio"`` \| ``"video"`` ; `trackNumber`: `number` ; `width?`: `number`  }[] |
| `options` | [`WebmLiveOption`](../interfaces/WebmLiveOption.md) |

## Properties

### audioStream

• **audioStream**: `WritableStream`<[`DepacketizerOutput`](../interfaces/DepacketizerOutput.md)\>

___

### stopped

• **stopped**: `boolean` = `false`

___

### tracks

• **tracks**: { `clockRate`: `number` ; `codec`: ``"AV1"`` \| ``"MPEG4/ISO/AVC"`` \| ``"VP8"`` \| ``"VP9"`` \| ``"OPUS"`` ; `height?`: `number` ; `kind`: ``"audio"`` \| ``"video"`` ; `trackNumber`: `number` ; `width?`: `number`  }[]

___

### videoStream

• **videoStream**: `WritableStream`<[`DepacketizerOutput`](../interfaces/DepacketizerOutput.md)\>

___

### webmStream

• **webmStream**: `ReadableStream`<[`WebmLiveOutput`](../modules.md#webmliveoutput)\>

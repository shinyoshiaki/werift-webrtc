[**werift**](../README.md) • **Docs**

***

[werift](../globals.md) / MediaStream

# Class: MediaStream

## Constructors

### new MediaStream()

> **new MediaStream**(`props`): [`MediaStream`](MediaStream.md)

#### Parameters

• **props**: [`MediaStreamTrack`](MediaStreamTrack.md)[] \| `Partial`\<[`MediaStream`](MediaStream.md)\>

#### Returns

[`MediaStream`](MediaStream.md)

## Properties

### id

> **id**: `string`

***

### tracks

> **tracks**: [`MediaStreamTrack`](MediaStreamTrack.md)[] = `[]`

## Methods

### addTrack()

> **addTrack**(`track`): `void`

#### Parameters

• **track**: [`MediaStreamTrack`](MediaStreamTrack.md)

#### Returns

`void`

***

### getAudioTracks()

> **getAudioTracks**(): [`MediaStreamTrack`](MediaStreamTrack.md)[]

#### Returns

[`MediaStreamTrack`](MediaStreamTrack.md)[]

***

### getTracks()

> **getTracks**(): [`MediaStreamTrack`](MediaStreamTrack.md)[]

#### Returns

[`MediaStreamTrack`](MediaStreamTrack.md)[]

***

### getVideoTracks()

> **getVideoTracks**(): [`MediaStreamTrack`](MediaStreamTrack.md)[]

#### Returns

[`MediaStreamTrack`](MediaStreamTrack.md)[]

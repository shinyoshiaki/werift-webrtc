[**werift**](../README.md)

***

[werift](../globals.md) / MediaStream

# Class: MediaStream

## Constructors

### new MediaStream()

> **new MediaStream**(`props`): [`MediaStream`](MediaStream.md)

#### Parameters

##### props

[`MediaStreamTrack`](MediaStreamTrack.md)[] | `Partial`\<[`MediaStream`](MediaStream.md)\>

#### Returns

[`MediaStream`](MediaStream.md)

## Properties

### id

> **id**: `string`

***

### tracks

> **tracks**: [`MediaStreamTrack`](MediaStreamTrack.md)[] = `[]`

## Accessors

### active

#### Get Signature

> **get** **active**(): `boolean`

##### Returns

`boolean`

## Methods

### addTrack()

> **addTrack**(`track`): `void`

#### Parameters

##### track

[`MediaStreamTrack`](MediaStreamTrack.md)

#### Returns

`void`

***

### clone()

> **clone**(): [`MediaStream`](MediaStream.md)

#### Returns

[`MediaStream`](MediaStream.md)

***

### getAudioTracks()

> **getAudioTracks**(): [`MediaStreamTrack`](MediaStreamTrack.md)[]

#### Returns

[`MediaStreamTrack`](MediaStreamTrack.md)[]

***

### getTrackById()

> **getTrackById**(`id`): `undefined` \| [`MediaStreamTrack`](MediaStreamTrack.md)

#### Parameters

##### id

`string`

#### Returns

`undefined` \| [`MediaStreamTrack`](MediaStreamTrack.md)

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

***

### removeTrack()

> **removeTrack**(`track`): `void`

#### Parameters

##### track

[`MediaStreamTrack`](MediaStreamTrack.md)

#### Returns

`void`

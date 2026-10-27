[**werift**](../README.md)

***

[werift](../globals.md) / MediaStream

# Class: MediaStream

## Constructors

### Constructor

> **new MediaStream**(`props?`): `MediaStream`

#### Parameters

##### props?

[`MediaStreamTrack`](MediaStreamTrack.md)[] \| `Partial`\<`MediaStream`\> = `{}`

#### Returns

`MediaStream`

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

> **clone**(): `MediaStream`

#### Returns

`MediaStream`

***

### getAudioTracks()

> **getAudioTracks**(): [`MediaStreamTrack`](MediaStreamTrack.md)[]

#### Returns

[`MediaStreamTrack`](MediaStreamTrack.md)[]

***

### getTrackById()

> **getTrackById**(`id`): [`MediaStreamTrack`](MediaStreamTrack.md) \| `undefined`

#### Parameters

##### id

`string`

#### Returns

[`MediaStreamTrack`](MediaStreamTrack.md) \| `undefined`

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

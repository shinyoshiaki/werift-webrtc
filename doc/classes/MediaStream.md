[werift](../README.md) / [Exports](../modules.md) / MediaStream

# Class: MediaStream

## Table of contents

### Constructors

- [constructor](MediaStream.md#constructor)

### Properties

- [id](MediaStream.md#id)
- [tracks](MediaStream.md#tracks)

### Methods

- [addTrack](MediaStream.md#addtrack)
- [getTracks](MediaStream.md#gettracks)

## Constructors

### constructor

• **new MediaStream**(`props`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`<[`MediaStream`](MediaStream.md)\> & `Pick`<[`MediaStream`](MediaStream.md), ``"id"``\> |

#### Defined in

[packages/webrtc/src/media/track.ts:68](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/media/track.ts#L68)

## Properties

### id

• **id**: `string`

#### Defined in

[packages/webrtc/src/media/track.ts:65](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/media/track.ts#L65)

___

### tracks

• **tracks**: [`MediaStreamTrack`](MediaStreamTrack.md)[] = `[]`

#### Defined in

[packages/webrtc/src/media/track.ts:66](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/media/track.ts#L66)

## Methods

### addTrack

▸ **addTrack**(`track`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `track` | [`MediaStreamTrack`](MediaStreamTrack.md) |

#### Returns

`void`

#### Defined in

[packages/webrtc/src/media/track.ts:72](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/media/track.ts#L72)

___

### getTracks

▸ **getTracks**(): [`MediaStreamTrack`](MediaStreamTrack.md)[]

#### Returns

[`MediaStreamTrack`](MediaStreamTrack.md)[]

#### Defined in

[packages/webrtc/src/media/track.ts:77](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/media/track.ts#L77)

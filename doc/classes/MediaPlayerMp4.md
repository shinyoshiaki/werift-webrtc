[werift](../README.md) / [Exports](../modules.md) / MediaPlayerMp4

# Class: MediaPlayerMp4

## Table of contents

### Constructors

- [constructor](MediaPlayerMp4.md#constructor)

### Properties

- [audio](MediaPlayerMp4.md#audio)
- [stopped](MediaPlayerMp4.md#stopped)
- [video](MediaPlayerMp4.md#video)

### Methods

- [start](MediaPlayerMp4.md#start)
- [stop](MediaPlayerMp4.md#stop)

## Constructors

### constructor

• **new MediaPlayerMp4**(`videoPort`, `audioPort`, `path`, `loop?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `videoPort` | `number` |
| `audioPort` | `number` |
| `path` | `string` |
| `loop?` | `boolean` |

## Properties

### audio

• **audio**: [`MediaStreamTrack`](MediaStreamTrack.md)

___

### stopped

• **stopped**: `boolean` = `false`

___

### video

• **video**: [`MediaStreamTrack`](MediaStreamTrack.md)

## Methods

### start

▸ **start**(): `Promise`<`void`\>

#### Returns

`Promise`<`void`\>

___

### stop

▸ **stop**(): `void`

#### Returns

`void`

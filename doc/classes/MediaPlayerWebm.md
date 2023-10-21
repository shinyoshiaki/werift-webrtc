[werift](../README.md) / [Exports](../modules.md) / MediaPlayerWebm

# Class: MediaPlayerWebm

## Table of contents

### Constructors

- [constructor](MediaPlayerWebm.md#constructor)

### Properties

- [audio](MediaPlayerWebm.md#audio)
- [stopped](MediaPlayerWebm.md#stopped)
- [video](MediaPlayerWebm.md#video)

### Methods

- [start](MediaPlayerWebm.md#start)
- [stop](MediaPlayerWebm.md#stop)

## Constructors

### constructor

• **new MediaPlayerWebm**(`videoPort`, `audioPort`, `path`, `loop?`)

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

[werift](../README.md) / [Exports](../modules.md) / MediaRecorder

# Class: MediaRecorder

## Table of contents

### Constructors

- [constructor](MediaRecorder.md#constructor)

### Properties

- [ext](MediaRecorder.md#ext)
- [options](MediaRecorder.md#options)
- [path](MediaRecorder.md#path)
- [tracks](MediaRecorder.md#tracks)
- [writer](MediaRecorder.md#writer)

### Methods

- [addTrack](MediaRecorder.md#addtrack)
- [start](MediaRecorder.md#start)
- [stop](MediaRecorder.md#stop)

## Constructors

### constructor

• **new MediaRecorder**(`tracks`, `path`, `options?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `tracks` | [`MediaStreamTrack`](MediaStreamTrack.md)[] |
| `path` | `string` |
| `options` | `Partial`<[`MediaRecorderOptions`](../interfaces/MediaRecorderOptions.md)\> |

#### Defined in

[packages/webrtc/src/nonstandard/recorder/index.ts:9](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/nonstandard/recorder/index.ts#L9)

## Properties

### ext

• **ext**: `string`

#### Defined in

[packages/webrtc/src/nonstandard/recorder/index.ts:7](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/nonstandard/recorder/index.ts#L7)

___

### options

• **options**: `Partial`<[`MediaRecorderOptions`](../interfaces/MediaRecorderOptions.md)\> = `{}`

#### Defined in

[packages/webrtc/src/nonstandard/recorder/index.ts:12](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/nonstandard/recorder/index.ts#L12)

___

### path

• **path**: `string`

#### Defined in

[packages/webrtc/src/nonstandard/recorder/index.ts:11](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/nonstandard/recorder/index.ts#L11)

___

### tracks

• **tracks**: [`MediaStreamTrack`](MediaStreamTrack.md)[]

#### Defined in

[packages/webrtc/src/nonstandard/recorder/index.ts:10](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/nonstandard/recorder/index.ts#L10)

___

### writer

• **writer**: `MediaWriter`

#### Defined in

[packages/webrtc/src/nonstandard/recorder/index.ts:6](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/nonstandard/recorder/index.ts#L6)

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

[packages/webrtc/src/nonstandard/recorder/index.ts:25](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/nonstandard/recorder/index.ts#L25)

___

### start

▸ **start**(): `void`

#### Returns

`void`

#### Defined in

[packages/webrtc/src/nonstandard/recorder/index.ts:29](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/nonstandard/recorder/index.ts#L29)

___

### stop

▸ **stop**(): `Promise`<`void`\>

#### Returns

`Promise`<`void`\>

#### Defined in

[packages/webrtc/src/nonstandard/recorder/index.ts:33](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/nonstandard/recorder/index.ts#L33)

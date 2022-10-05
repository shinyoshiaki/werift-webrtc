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

## Properties

### ext

• **ext**: `string`

___

### options

• **options**: `Partial`<[`MediaRecorderOptions`](../interfaces/MediaRecorderOptions.md)\> = `{}`

___

### path

• **path**: `string`

___

### tracks

• **tracks**: [`MediaStreamTrack`](MediaStreamTrack.md)[]

___

### writer

• **writer**: `MediaWriter`

## Methods

### addTrack

▸ **addTrack**(`track`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `track` | [`MediaStreamTrack`](MediaStreamTrack.md) |

#### Returns

`void`

___

### start

▸ **start**(): `Promise`<`void`\>

#### Returns

`Promise`<`void`\>

___

### stop

▸ **stop**(): `Promise`<`void`\>

#### Returns

`Promise`<`void`\>

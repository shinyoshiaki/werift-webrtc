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

## Properties

### id

• **id**: `string`

___

### tracks

• **tracks**: [`MediaStreamTrack`](MediaStreamTrack.md)[] = `[]`

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

### getTracks

▸ **getTracks**(): [`MediaStreamTrack`](MediaStreamTrack.md)[]

#### Returns

[`MediaStreamTrack`](MediaStreamTrack.md)[]

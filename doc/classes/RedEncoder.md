[werift](../README.md) / [Exports](../modules.md) / RedEncoder

# Class: RedEncoder

## Table of contents

### Constructors

- [constructor](RedEncoder.md#constructor)

### Properties

- [cache](RedEncoder.md#cache)
- [cacheSize](RedEncoder.md#cachesize)
- [distance](RedEncoder.md#distance)

### Methods

- [build](RedEncoder.md#build)
- [push](RedEncoder.md#push)

## Constructors

### constructor

• **new RedEncoder**(`distance?`)

#### Parameters

| Name | Type | Default value |
| :------ | :------ | :------ |
| `distance` | `number` | `1` |

#### Defined in

[packages/rtp/src/rtp/red/encoder.ts:8](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtp/red/encoder.ts#L8)

## Properties

### cache

• `Private` **cache**: { `block`: `Buffer` ; `blockPT`: `number` ; `timestamp`: `number`  }[] = `[]`

#### Defined in

[packages/rtp/src/rtp/red/encoder.ts:5](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtp/red/encoder.ts#L5)

___

### cacheSize

• **cacheSize**: `number` = `10`

#### Defined in

[packages/rtp/src/rtp/red/encoder.ts:6](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtp/red/encoder.ts#L6)

___

### distance

• **distance**: `number` = `1`

#### Defined in

[packages/rtp/src/rtp/red/encoder.ts:8](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtp/red/encoder.ts#L8)

## Methods

### build

▸ **build**(): [`Red`](Red.md)

#### Returns

[`Red`](Red.md)

#### Defined in

[packages/rtp/src/rtp/red/encoder.ts:17](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtp/red/encoder.ts#L17)

___

### push

▸ **push**(`payload`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `payload` | `Object` |
| `payload.block` | `Buffer` |
| `payload.blockPT` | `number` |
| `payload.timestamp` | `number` |

#### Returns

`void`

#### Defined in

[packages/rtp/src/rtp/red/encoder.ts:10](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtp/red/encoder.ts#L10)

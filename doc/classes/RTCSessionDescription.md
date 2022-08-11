[werift](../README.md) / [Exports](../modules.md) / RTCSessionDescription

# Class: RTCSessionDescription

## Table of contents

### Constructors

- [constructor](RTCSessionDescription.md#constructor)

### Properties

- [sdp](RTCSessionDescription.md#sdp)
- [type](RTCSessionDescription.md#type)

### Methods

- [isThis](RTCSessionDescription.md#isthis)

## Constructors

### constructor

• **new RTCSessionDescription**(`sdp`, `type`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `sdp` | `string` |
| `type` | ``"offer"`` \| ``"answer"`` |

#### Defined in

[packages/webrtc/src/sdp.ts:613](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L613)

## Properties

### sdp

• **sdp**: `string`

#### Defined in

[packages/webrtc/src/sdp.ts:613](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L613)

___

### type

• **type**: ``"offer"`` \| ``"answer"``

#### Defined in

[packages/webrtc/src/sdp.ts:613](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L613)

## Methods

### isThis

▸ `Static` **isThis**(`o`): `undefined` \| ``true``

#### Parameters

| Name | Type |
| :------ | :------ |
| `o` | `any` |

#### Returns

`undefined` \| ``true``

#### Defined in

[packages/webrtc/src/sdp.ts:614](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L614)

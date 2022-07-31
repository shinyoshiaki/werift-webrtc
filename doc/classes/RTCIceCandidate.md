[werift](../README.md) / [Exports](../modules.md) / RTCIceCandidate

# Class: RTCIceCandidate

## Table of contents

### Constructors

- [constructor](RTCIceCandidate.md#constructor)

### Properties

- [candidate](RTCIceCandidate.md#candidate)
- [sdpMLineIndex](RTCIceCandidate.md#sdpmlineindex)
- [sdpMid](RTCIceCandidate.md#sdpmid)

### Methods

- [toJSON](RTCIceCandidate.md#tojson)
- [isThis](RTCIceCandidate.md#isthis)

## Constructors

### constructor

• **new RTCIceCandidate**(`props`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`<[`RTCIceCandidate`](RTCIceCandidate.md)\> |

#### Defined in

[packages/webrtc/src/transport/ice.ts:180](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/ice.ts#L180)

## Properties

### candidate

• **candidate**: `string`

#### Defined in

[packages/webrtc/src/transport/ice.ts:176](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/ice.ts#L176)

___

### sdpMLineIndex

• `Optional` **sdpMLineIndex**: `number`

#### Defined in

[packages/webrtc/src/transport/ice.ts:178](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/ice.ts#L178)

___

### sdpMid

• `Optional` **sdpMid**: `string`

#### Defined in

[packages/webrtc/src/transport/ice.ts:177](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/ice.ts#L177)

## Methods

### toJSON

▸ **toJSON**(): `Object`

#### Returns

`Object`

| Name | Type |
| :------ | :------ |
| `candidate` | `string` |
| `sdpMLineIndex` | `undefined` \| `number` |
| `sdpMid` | `undefined` \| `string` |

#### Defined in

[packages/webrtc/src/transport/ice.ts:188](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/ice.ts#L188)

___

### isThis

▸ `Static` **isThis**(`o`): `undefined` \| ``true``

#### Parameters

| Name | Type |
| :------ | :------ |
| `o` | `any` |

#### Returns

`undefined` \| ``true``

#### Defined in

[packages/webrtc/src/transport/ice.ts:184](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/ice.ts#L184)

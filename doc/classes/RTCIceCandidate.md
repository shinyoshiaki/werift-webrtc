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

## Properties

### candidate

• **candidate**: `string`

___

### sdpMLineIndex

• `Optional` **sdpMLineIndex**: `number`

___

### sdpMid

• `Optional` **sdpMid**: `string`

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

___

### isThis

▸ `Static` **isThis**(`o`): `undefined` \| ``true``

#### Parameters

| Name | Type |
| :------ | :------ |
| `o` | `any` |

#### Returns

`undefined` \| ``true``

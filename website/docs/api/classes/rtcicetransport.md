---
id: "rtcicetransport"
title: "Class: RTCIceTransport"
sidebar_label: "RTCIceTransport"
sidebar_position: 0
custom_edit_url: null
---

## Constructors

### constructor

• **new RTCIceTransport**(`gather`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `gather` | [RTCIceGatherer](rtcicegatherer.md) |

#### Defined in

[packages/webrtc/src/transport/ice.ts:12](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/ice.ts#L12)

## Properties

### connection

• **connection**: `Connection`

#### Defined in

[packages/webrtc/src/transport/ice.ts:7](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/ice.ts#L7)

___

### onStateChange

• `Readonly` **onStateChange**: `default`<[``"closed"`` \| ``"failed"`` \| ``"disconnected"`` \| ``"new"`` \| ``"connected"`` \| ``"checking"`` \| ``"completed"``]\>

#### Defined in

[packages/webrtc/src/transport/ice.ts:10](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/ice.ts#L10)

___

### state

• **state**: ``"closed"`` \| ``"failed"`` \| ``"disconnected"`` \| ``"new"`` \| ``"connected"`` \| ``"checking"`` \| ``"completed"`` = "new"

#### Defined in

[packages/webrtc/src/transport/ice.ts:8](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/ice.ts#L8)

___

### waitStart

• `Private` `Optional` **waitStart**: `default`<[]\>

#### Defined in

[packages/webrtc/src/transport/ice.ts:12](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/ice.ts#L12)

## Accessors

### iceGather

• `get` **iceGather**(): [RTCIceGatherer](rtcicegatherer.md)

#### Returns

[RTCIceGatherer](rtcicegatherer.md)

#### Defined in

[packages/webrtc/src/transport/ice.ts:20](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/ice.ts#L20)

___

### role

• `get` **role**(): ``"controlling"`` \| ``"controlled"``

#### Returns

``"controlling"`` \| ``"controlled"``

#### Defined in

[packages/webrtc/src/transport/ice.ts:24](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/ice.ts#L24)

## Methods

### addRemoteCandidate

▸ **addRemoteCandidate**(`candidate?`): `Promise`<void\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `candidate?` | `RTCIceCandidate` |

#### Returns

`Promise`<void\>

#### Defined in

[packages/webrtc/src/transport/ice.ts:44](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/ice.ts#L44)

___

### setState

▸ `Private` **setState**(`state`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `state` | ``"closed"`` \| ``"failed"`` \| ``"disconnected"`` \| ``"new"`` \| ``"connected"`` \| ``"checking"`` \| ``"completed"`` |

#### Returns

`void`

#### Defined in

[packages/webrtc/src/transport/ice.ts:29](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/ice.ts#L29)

___

### start

▸ **start**(`remoteParameters`): `Promise`<void\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `remoteParameters` | `RTCIceParameters` |

#### Returns

`Promise`<void\>

#### Defined in

[packages/webrtc/src/transport/ice.ts:54](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/ice.ts#L54)

___

### stop

▸ **stop**(): `Promise`<void\>

#### Returns

`Promise`<void\>

#### Defined in

[packages/webrtc/src/transport/ice.ts:76](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/ice.ts#L76)

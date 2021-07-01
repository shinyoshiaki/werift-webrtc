---
id: "icecandidate"
title: "Class: IceCandidate"
sidebar_label: "IceCandidate"
sidebar_position: 0
custom_edit_url: null
---

## Constructors

### constructor

• **new IceCandidate**(`component`, `foundation`, `ip`, `port`, `priority`, `protocol`, `type`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `component` | `number` |
| `foundation` | `string` |
| `ip` | `string` |
| `port` | `number` |
| `priority` | `number` |
| `protocol` | `string` |
| `type` | `string` |

#### Defined in

[packages/webrtc/src/transport/ice.ts:185](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/transport/ice.ts#L185)

## Properties

### component

• **component**: `number`

___

### foundation

• **foundation**: `string`

___

### ip

• **ip**: `string`

___

### port

• **port**: `number`

___

### priority

• **priority**: `number`

___

### protocol

• **protocol**: `string`

___

### relatedAddress

• `Optional` **relatedAddress**: `string`

#### Defined in

[packages/webrtc/src/transport/ice.ts:181](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/transport/ice.ts#L181)

___

### relatedPort

• `Optional` **relatedPort**: `number`

#### Defined in

[packages/webrtc/src/transport/ice.ts:182](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/transport/ice.ts#L182)

___

### sdpMLineIndex

• `Optional` **sdpMLineIndex**: `number`

#### Defined in

[packages/webrtc/src/transport/ice.ts:184](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/transport/ice.ts#L184)

___

### sdpMid

• `Optional` **sdpMid**: `string`

#### Defined in

[packages/webrtc/src/transport/ice.ts:183](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/transport/ice.ts#L183)

___

### tcpType

• `Optional` **tcpType**: `string`

#### Defined in

[packages/webrtc/src/transport/ice.ts:185](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/transport/ice.ts#L185)

___

### type

• **type**: `string`

## Methods

### toJSON

▸ **toJSON**(): [RTCIceCandidate](../modules.md#rtcicecandidate)

#### Returns

[RTCIceCandidate](../modules.md#rtcicecandidate)

#### Defined in

[packages/webrtc/src/transport/ice.ts:197](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/transport/ice.ts#L197)

___

### fromJSON

▸ `Static` **fromJSON**(`data`): `undefined` \| [IceCandidate](icecandidate.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | [RTCIceCandidate](../modules.md#rtcicecandidate) |

#### Returns

`undefined` \| [IceCandidate](icecandidate.md)

#### Defined in

[packages/webrtc/src/transport/ice.ts:205](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/transport/ice.ts#L205)

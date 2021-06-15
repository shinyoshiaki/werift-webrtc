---
id: "promisequeue"
title: "Class: PromiseQueue"
sidebar_label: "PromiseQueue"
sidebar_position: 0
custom_edit_url: null
---

## Constructors

### constructor

• **new PromiseQueue**()

## Properties

### queue

• **queue**: { `call`: () => `void` ; `promise`: () => `Promise`<any\>  }[] = []

#### Defined in

[packages/webrtc/src/helper.ts:13](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/helper.ts#L13)

___

### running

• **running**: `boolean` = false

#### Defined in

[packages/webrtc/src/helper.ts:14](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/helper.ts#L14)

## Methods

### push

▸ **push**(`promise`): `Promise`<void\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `promise` | () => `Promise`<any\> |

#### Returns

`Promise`<void\>

#### Defined in

[packages/webrtc/src/helper.ts:16](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/helper.ts#L16)

___

### run

▸ **run**(): `Promise`<void\>

#### Returns

`Promise`<void\>

#### Defined in

[packages/webrtc/src/helper.ts:22](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/helper.ts#L22)

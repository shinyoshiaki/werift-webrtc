---
id: "promisequeue"
title: "Class: PromiseQueue"
sidebar_label: "PromiseQueue"
custom_edit_url: null
hide_title: true
---

# Class: PromiseQueue

## Constructors

### constructor

\+ **new PromiseQueue**(): [*PromiseQueue*](promisequeue.md)

**Returns:** [*PromiseQueue*](promisequeue.md)

## Properties

### queue

• **queue**: { `call`: () => *void* ; `promise`: () => *Promise*<any\>  }[]

Defined in: [webrtc/src/helper.ts:15](https://github.com/shinyoshiaki/werift-webrtc/blob/b7c7a6e/packages/webrtc/src/helper.ts#L15)

___

### running

• **running**: *boolean*= false

Defined in: [webrtc/src/helper.ts:16](https://github.com/shinyoshiaki/werift-webrtc/blob/b7c7a6e/packages/webrtc/src/helper.ts#L16)

## Methods

### push

▸ **push**(`promise`: () => *Promise*<any\>): *Promise*<void\>

#### Parameters:

Name | Type |
:------ | :------ |
`promise` | () => *Promise*<any\> |

**Returns:** *Promise*<void\>

Defined in: [webrtc/src/helper.ts:18](https://github.com/shinyoshiaki/werift-webrtc/blob/b7c7a6e/packages/webrtc/src/helper.ts#L18)

___

### run

▸ **run**(): *Promise*<void\>

**Returns:** *Promise*<void\>

Defined in: [webrtc/src/helper.ts:24](https://github.com/shinyoshiaki/werift-webrtc/blob/b7c7a6e/packages/webrtc/src/helper.ts#L24)

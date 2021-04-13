---
id: "rtcdatachannel"
title: "Class: RTCDataChannel"
sidebar_label: "RTCDataChannel"
custom_edit_url: null
hide_title: true
---

# Class: RTCDataChannel

## Constructors

### constructor

\+ **new RTCDataChannel**(`transport`: [*RTCSctpTransport*](rtcsctptransport.md), `parameters`: *RTCDataChannelParameters*, `sendOpen?`: *boolean*): [*RTCDataChannel*](rtcdatachannel.md)

#### Parameters:

Name | Type | Default value |
:------ | :------ | :------ |
`transport` | [*RTCSctpTransport*](rtcsctptransport.md) | - |
`parameters` | *RTCDataChannelParameters* | - |
`sendOpen` | *boolean* | true |

**Returns:** [*RTCDataChannel*](rtcdatachannel.md)

Defined in: [webrtc/src/dataChannel.ts:33](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/webrtc/src/dataChannel.ts#L33)

## Properties

### \_bufferedAmountLowThreshold

• `Private` **\_bufferedAmountLowThreshold**: *number*= 0

Defined in: [webrtc/src/dataChannel.ts:33](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/webrtc/src/dataChannel.ts#L33)

___

### bufferedAmount

• **bufferedAmount**: *number*= 0

Defined in: [webrtc/src/dataChannel.ts:32](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/webrtc/src/dataChannel.ts#L32)

___

### bufferedAmountLow

• `Readonly` **bufferedAmountLow**: *default*<any[]\>

Defined in: [webrtc/src/dataChannel.ts:22](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/webrtc/src/dataChannel.ts#L22)

___

### id

• **id**: *number*

Defined in: [webrtc/src/dataChannel.ts:29](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/webrtc/src/dataChannel.ts#L29)

___

### isCreatedByRemote

• **isCreatedByRemote**: *boolean*= false

Defined in: [webrtc/src/dataChannel.ts:28](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/webrtc/src/dataChannel.ts#L28)

___

### message

• `Readonly` **message**: *default*<[*string* \| *Buffer*]\>

Defined in: [webrtc/src/dataChannel.ts:21](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/webrtc/src/dataChannel.ts#L21)

___

### onclose

• `Optional` **onclose**: *null* \| () => *void*

Defined in: [webrtc/src/dataChannel.ts:24](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/webrtc/src/dataChannel.ts#L24)

___

### onclosing

• `Optional` **onclosing**: *null* \| () => *void*

Defined in: [webrtc/src/dataChannel.ts:25](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/webrtc/src/dataChannel.ts#L25)

___

### onerror

• `Optional` **onerror**: *null* \| (`props`: { `error`: *any*  }) => *void*

Defined in: [webrtc/src/dataChannel.ts:27](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/webrtc/src/dataChannel.ts#L27)

___

### onopen

• `Optional` **onopen**: *null* \| () => *void*

Defined in: [webrtc/src/dataChannel.ts:23](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/webrtc/src/dataChannel.ts#L23)

___

### readyState

• **readyState**: DCState= "connecting"

Defined in: [webrtc/src/dataChannel.ts:30](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/webrtc/src/dataChannel.ts#L30)

___

### sendOpen

• `Readonly` **sendOpen**: *boolean*= true

___

### stateChanged

• `Readonly` **stateChanged**: *default*<[DCState]\>

Defined in: [webrtc/src/dataChannel.ts:20](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/webrtc/src/dataChannel.ts#L20)

## Accessors

### bufferedAmountLowThreshold

• get **bufferedAmountLowThreshold**(): *number*

**Returns:** *number*

Defined in: [webrtc/src/dataChannel.ts:78](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/webrtc/src/dataChannel.ts#L78)

• set **bufferedAmountLowThreshold**(`value`: *number*): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`value` | *number* |

**Returns:** *void*

Defined in: [webrtc/src/dataChannel.ts:82](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/webrtc/src/dataChannel.ts#L82)

___

### label

• get **label**(): *string*

**Returns:** *string*

Defined in: [webrtc/src/dataChannel.ts:66](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/webrtc/src/dataChannel.ts#L66)

___

### maxPacketLifeTime

• get **maxPacketLifeTime**(): *undefined* \| *number*

**Returns:** *undefined* \| *number*

Defined in: [webrtc/src/dataChannel.ts:62](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/webrtc/src/dataChannel.ts#L62)

___

### maxRetransmits

• get **maxRetransmits**(): *undefined* \| *number*

**Returns:** *undefined* \| *number*

Defined in: [webrtc/src/dataChannel.ts:58](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/webrtc/src/dataChannel.ts#L58)

___

### negotiated

• get **negotiated**(): *boolean*

**Returns:** *boolean*

Defined in: [webrtc/src/dataChannel.ts:74](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/webrtc/src/dataChannel.ts#L74)

___

### ordered

• get **ordered**(): *boolean*

**Returns:** *boolean*

Defined in: [webrtc/src/dataChannel.ts:54](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/webrtc/src/dataChannel.ts#L54)

___

### protocol

• get **protocol**(): *string*

**Returns:** *string*

Defined in: [webrtc/src/dataChannel.ts:70](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/webrtc/src/dataChannel.ts#L70)

## Methods

### addBufferedAmount

▸ **addBufferedAmount**(`amount`: *number*): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`amount` | *number* |

**Returns:** *void*

Defined in: [webrtc/src/dataChannel.ts:113](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/webrtc/src/dataChannel.ts#L113)

___

### close

▸ **close**(): *void*

**Returns:** *void*

Defined in: [webrtc/src/dataChannel.ts:127](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/webrtc/src/dataChannel.ts#L127)

___

### send

▸ **send**(`data`: *string* \| *Buffer*): *Promise*<void\>

#### Parameters:

Name | Type |
:------ | :------ |
`data` | *string* \| *Buffer* |

**Returns:** *Promise*<void\>

Defined in: [webrtc/src/dataChannel.ts:123](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/webrtc/src/dataChannel.ts#L123)

___

### setId

▸ **setId**(`id`: *number*): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`id` | *number* |

**Returns:** *void*

Defined in: [webrtc/src/dataChannel.ts:90](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/webrtc/src/dataChannel.ts#L90)

___

### setReadyState

▸ **setReadyState**(`state`: DCState): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`state` | DCState |

**Returns:** *void*

Defined in: [webrtc/src/dataChannel.ts:94](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/webrtc/src/dataChannel.ts#L94)

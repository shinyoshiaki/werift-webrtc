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

Defined in: [webrtc/src/dataChannel.ts:35](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/dataChannel.ts#L35)

## Properties

### \_bufferedAmountLowThreshold

• `Private` **\_bufferedAmountLowThreshold**: *number*= 0

Defined in: [webrtc/src/dataChannel.ts:35](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/dataChannel.ts#L35)

___

### bufferedAmount

• **bufferedAmount**: *number*= 0

Defined in: [webrtc/src/dataChannel.ts:34](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/dataChannel.ts#L34)

___

### bufferedAmountLow

• `Readonly` **bufferedAmountLow**: *default*<any[]\>

Defined in: [webrtc/src/dataChannel.ts:24](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/dataChannel.ts#L24)

___

### error

• `Readonly` **error**: *default*<[Error]\>

Defined in: [webrtc/src/dataChannel.ts:23](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/dataChannel.ts#L23)

___

### id

• **id**: *number*

Defined in: [webrtc/src/dataChannel.ts:31](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/dataChannel.ts#L31)

___

### isCreatedByRemote

• **isCreatedByRemote**: *boolean*= false

Defined in: [webrtc/src/dataChannel.ts:30](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/dataChannel.ts#L30)

___

### message

• `Readonly` **message**: *default*<[*string* \| *Buffer*]\>

Defined in: [webrtc/src/dataChannel.ts:21](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/dataChannel.ts#L21)

___

### onclose

• `Optional` **onclose**: *null* \| () => *void*

Defined in: [webrtc/src/dataChannel.ts:26](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/dataChannel.ts#L26)

___

### onclosing

• `Optional` **onclosing**: *null* \| () => *void*

Defined in: [webrtc/src/dataChannel.ts:27](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/dataChannel.ts#L27)

___

### onerror

• `Optional` **onerror**: *null* \| (`props`: { `error`: *any*  }) => *void*

Defined in: [webrtc/src/dataChannel.ts:29](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/dataChannel.ts#L29)

___

### onopen

• `Optional` **onopen**: *null* \| () => *void*

Defined in: [webrtc/src/dataChannel.ts:25](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/dataChannel.ts#L25)

___

### readyState

• **readyState**: DCState= "connecting"

Defined in: [webrtc/src/dataChannel.ts:32](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/dataChannel.ts#L32)

___

### sendOpen

• `Readonly` **sendOpen**: *boolean*= true

___

### stateChanged

• `Readonly` **stateChanged**: *default*<[DCState]\>

Defined in: [webrtc/src/dataChannel.ts:20](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/dataChannel.ts#L20)

## Accessors

### bufferedAmountLowThreshold

• get **bufferedAmountLowThreshold**(): *number*

**Returns:** *number*

Defined in: [webrtc/src/dataChannel.ts:80](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/dataChannel.ts#L80)

• set **bufferedAmountLowThreshold**(`value`: *number*): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`value` | *number* |

**Returns:** *void*

Defined in: [webrtc/src/dataChannel.ts:84](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/dataChannel.ts#L84)

___

### label

• get **label**(): *string*

**Returns:** *string*

Defined in: [webrtc/src/dataChannel.ts:68](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/dataChannel.ts#L68)

___

### maxPacketLifeTime

• get **maxPacketLifeTime**(): *undefined* \| *number*

**Returns:** *undefined* \| *number*

Defined in: [webrtc/src/dataChannel.ts:64](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/dataChannel.ts#L64)

___

### maxRetransmits

• get **maxRetransmits**(): *undefined* \| *number*

**Returns:** *undefined* \| *number*

Defined in: [webrtc/src/dataChannel.ts:60](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/dataChannel.ts#L60)

___

### negotiated

• get **negotiated**(): *boolean*

**Returns:** *boolean*

Defined in: [webrtc/src/dataChannel.ts:76](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/dataChannel.ts#L76)

___

### ordered

• get **ordered**(): *boolean*

**Returns:** *boolean*

Defined in: [webrtc/src/dataChannel.ts:56](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/dataChannel.ts#L56)

___

### protocol

• get **protocol**(): *string*

**Returns:** *string*

Defined in: [webrtc/src/dataChannel.ts:72](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/dataChannel.ts#L72)

## Methods

### addBufferedAmount

▸ **addBufferedAmount**(`amount`: *number*): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`amount` | *number* |

**Returns:** *void*

Defined in: [webrtc/src/dataChannel.ts:115](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/dataChannel.ts#L115)

___

### close

▸ **close**(): *void*

**Returns:** *void*

Defined in: [webrtc/src/dataChannel.ts:129](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/dataChannel.ts#L129)

___

### send

▸ **send**(`data`: *string* \| *Buffer*): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`data` | *string* \| *Buffer* |

**Returns:** *void*

Defined in: [webrtc/src/dataChannel.ts:125](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/dataChannel.ts#L125)

___

### setId

▸ **setId**(`id`: *number*): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`id` | *number* |

**Returns:** *void*

Defined in: [webrtc/src/dataChannel.ts:92](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/dataChannel.ts#L92)

___

### setReadyState

▸ **setReadyState**(`state`: DCState): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`state` | DCState |

**Returns:** *void*

Defined in: [webrtc/src/dataChannel.ts:96](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/dataChannel.ts#L96)

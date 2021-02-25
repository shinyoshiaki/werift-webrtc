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

Defined in: [webrtc/src/dataChannel.ts:28](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/dataChannel.ts#L28)

## Properties

### \_bufferedAmountLowThreshold

• `Private` **\_bufferedAmountLowThreshold**: *number*= 0

Defined in: [webrtc/src/dataChannel.ts:28](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/dataChannel.ts#L28)

___

### bufferedAmount

• `Private` **bufferedAmount**: *number*= 0

Defined in: [webrtc/src/dataChannel.ts:27](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/dataChannel.ts#L27)

___

### bufferedAmountLow

• `Readonly` **bufferedAmountLow**: *default*<any[]\>

Defined in: [webrtc/src/dataChannel.ts:22](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/dataChannel.ts#L22)

___

### id

• **id**: *number*

Defined in: [webrtc/src/dataChannel.ts:24](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/dataChannel.ts#L24)

___

### message

• `Readonly` **message**: *default*<[*string* \| *Buffer*]\>

Defined in: [webrtc/src/dataChannel.ts:21](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/dataChannel.ts#L21)

___

### readyState

• **readyState**: DCState= "connecting"

Defined in: [webrtc/src/dataChannel.ts:25](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/dataChannel.ts#L25)

___

### sendOpen

• `Readonly` **sendOpen**: *boolean*= true

___

### stateChanged

• `Readonly` **stateChanged**: *default*<[DCState]\>

Defined in: [webrtc/src/dataChannel.ts:20](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/dataChannel.ts#L20)

## Accessors

### bufferedAmountLowThreshold

• get **bufferedAmountLowThreshold**(): *number*

**Returns:** *number*

Defined in: [webrtc/src/dataChannel.ts:73](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/dataChannel.ts#L73)

• set **bufferedAmountLowThreshold**(`value`: *number*): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`value` | *number* |

**Returns:** *void*

Defined in: [webrtc/src/dataChannel.ts:77](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/dataChannel.ts#L77)

___

### label

• get **label**(): *string*

**Returns:** *string*

Defined in: [webrtc/src/dataChannel.ts:61](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/dataChannel.ts#L61)

___

### maxPacketLifeTime

• get **maxPacketLifeTime**(): *undefined* \| *number*

**Returns:** *undefined* \| *number*

Defined in: [webrtc/src/dataChannel.ts:57](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/dataChannel.ts#L57)

___

### maxRetransmits

• get **maxRetransmits**(): *undefined* \| *number*

**Returns:** *undefined* \| *number*

Defined in: [webrtc/src/dataChannel.ts:53](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/dataChannel.ts#L53)

___

### negotiated

• get **negotiated**(): *boolean*

**Returns:** *boolean*

Defined in: [webrtc/src/dataChannel.ts:69](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/dataChannel.ts#L69)

___

### ordered

• get **ordered**(): *boolean*

**Returns:** *boolean*

Defined in: [webrtc/src/dataChannel.ts:49](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/dataChannel.ts#L49)

___

### protocol

• get **protocol**(): *string*

**Returns:** *string*

Defined in: [webrtc/src/dataChannel.ts:65](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/dataChannel.ts#L65)

## Methods

### addBufferedAmount

▸ **addBufferedAmount**(`amount`: *number*): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`amount` | *number* |

**Returns:** *void*

Defined in: [webrtc/src/dataChannel.ts:96](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/dataChannel.ts#L96)

___

### close

▸ **close**(): *void*

**Returns:** *void*

Defined in: [webrtc/src/dataChannel.ts:111](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/dataChannel.ts#L111)

___

### send

▸ **send**(`data`: *string* \| *Buffer*): *Promise*<void\>

#### Parameters:

Name | Type |
:------ | :------ |
`data` | *string* \| *Buffer* |

**Returns:** *Promise*<void\>

Defined in: [webrtc/src/dataChannel.ts:106](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/dataChannel.ts#L106)

___

### setId

▸ **setId**(`id`: *number*): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`id` | *number* |

**Returns:** *void*

Defined in: [webrtc/src/dataChannel.ts:85](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/dataChannel.ts#L85)

___

### setReadyState

▸ **setReadyState**(`state`: DCState): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`state` | DCState |

**Returns:** *void*

Defined in: [webrtc/src/dataChannel.ts:89](https://github.com/shinyoshiaki/werift-webrtc/blob/ea933e6/packages/webrtc/src/dataChannel.ts#L89)

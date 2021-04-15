---
id: "rtcsctptransport"
title: "Class: RTCSctpTransport"
sidebar_label: "RTCSctpTransport"
custom_edit_url: null
hide_title: true
---

# Class: RTCSctpTransport

## Constructors

### constructor

\+ **new RTCSctpTransport**(`dtlsTransport`: [*RTCDtlsTransport*](rtcdtlstransport.md), `port?`: *number*): [*RTCSctpTransport*](rtcsctptransport.md)

#### Parameters:

Name | Type | Default value |
:------ | :------ | :------ |
`dtlsTransport` | [*RTCDtlsTransport*](rtcdtlstransport.md) | - |
`port` | *number* | 5000 |

**Returns:** [*RTCSctpTransport*](rtcsctptransport.md)

Defined in: [webrtc/src/transport/sctp.ts:35](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/transport/sctp.ts#L35)

## Properties

### bundled

• **bundled**: *boolean*= false

Defined in: [webrtc/src/transport/sctp.ts:31](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/transport/sctp.ts#L31)

___

### dataChannelId

• `Private` `Optional` **dataChannelId**: *number*

Defined in: [webrtc/src/transport/sctp.ts:35](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/transport/sctp.ts#L35)

___

### dataChannelQueue

• `Private` **dataChannelQueue**: [[*RTCDataChannel*](rtcdatachannel.md), *number*, *Buffer*][]= []

Defined in: [webrtc/src/transport/sctp.ts:34](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/transport/sctp.ts#L34)

___

### dataChannels

• **dataChannels**: *object*= {}

#### Type declaration:

Defined in: [webrtc/src/transport/sctp.ts:32](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/transport/sctp.ts#L32)

___

### dtlsTransport

• **dtlsTransport**: [*RTCDtlsTransport*](rtcdtlstransport.md)

___

### mid

• `Optional` **mid**: *string*

Defined in: [webrtc/src/transport/sctp.ts:30](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/transport/sctp.ts#L30)

___

### onDataChannel

• `Readonly` **onDataChannel**: *default*<[[*RTCDataChannel*](rtcdatachannel.md)]\>

Defined in: [webrtc/src/transport/sctp.ts:27](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/transport/sctp.ts#L27)

___

### port

• **port**: *number*= 5000

___

### sctp

• `Readonly` **sctp**: *SCTP*

Defined in: [webrtc/src/transport/sctp.ts:29](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/transport/sctp.ts#L29)

___

### uuid

• `Readonly` **uuid**: *string*

Defined in: [webrtc/src/transport/sctp.ts:28](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/transport/sctp.ts#L28)

## Accessors

### isServer

• `Private`get **isServer**(): *boolean*

**Returns:** *boolean*

Defined in: [webrtc/src/transport/sctp.ts:77](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/transport/sctp.ts#L77)

## Methods

### channelByLabel

▸ **channelByLabel**(`label`: *string*): *undefined* \| [*RTCDataChannel*](rtcdatachannel.md)

#### Parameters:

Name | Type |
:------ | :------ |
`label` | *string* |

**Returns:** *undefined* \| [*RTCDataChannel*](rtcdatachannel.md)

Defined in: [webrtc/src/transport/sctp.ts:81](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/transport/sctp.ts#L81)

___

### dataChannelAddNegotiated

▸ **dataChannelAddNegotiated**(`channel`: [*RTCDataChannel*](rtcdatachannel.md)): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`channel` | [*RTCDataChannel*](rtcdatachannel.md) |

**Returns:** *void*

Defined in: [webrtc/src/transport/sctp.ts:181](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/transport/sctp.ts#L181)

___

### dataChannelClose

▸ **dataChannelClose**(`channel`: [*RTCDataChannel*](rtcdatachannel.md)): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`channel` | [*RTCDataChannel*](rtcdatachannel.md) |

**Returns:** *void*

Defined in: [webrtc/src/transport/sctp.ts:325](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/transport/sctp.ts#L325)

___

### dataChannelFlush

▸ `Private`**dataChannelFlush**(): *void*

**Returns:** *void*

Defined in: [webrtc/src/transport/sctp.ts:238](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/transport/sctp.ts#L238)

___

### dataChannelOpen

▸ **dataChannelOpen**(`channel`: [*RTCDataChannel*](rtcdatachannel.md)): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`channel` | [*RTCDataChannel*](rtcdatachannel.md) |

**Returns:** *void*

Defined in: [webrtc/src/transport/sctp.ts:196](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/transport/sctp.ts#L196)

___

### datachannelReceive

▸ `Private`**datachannelReceive**(`streamId`: *number*, `ppId`: *number*, `data`: *Buffer*): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`streamId` | *number* |
`ppId` | *number* |
`data` | *Buffer* |

**Returns:** *void*

Defined in: [webrtc/src/transport/sctp.ts:85](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/transport/sctp.ts#L85)

___

### datachannelSend

▸ **datachannelSend**(`channel`: [*RTCDataChannel*](rtcdatachannel.md), `data`: *string* \| *Buffer*): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`channel` | [*RTCDataChannel*](rtcdatachannel.md) |
`data` | *string* \| *Buffer* |

**Returns:** *void*

Defined in: [webrtc/src/transport/sctp.ts:289](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/transport/sctp.ts#L289)

___

### start

▸ **start**(`remotePort`: *number*): *Promise*<void\>

#### Parameters:

Name | Type |
:------ | :------ |
`remotePort` | *number* |

**Returns:** *Promise*<void\>

Defined in: [webrtc/src/transport/sctp.ts:309](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/transport/sctp.ts#L309)

___

### stop

▸ **stop**(): *void*

**Returns:** *void*

Defined in: [webrtc/src/transport/sctp.ts:320](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/transport/sctp.ts#L320)

___

### getCapabilities

▸ `Static`**getCapabilities**(): *RTCSctpCapabilities*

**Returns:** *RTCSctpCapabilities*

Defined in: [webrtc/src/transport/sctp.ts:305](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/transport/sctp.ts#L305)

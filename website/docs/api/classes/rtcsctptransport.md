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

Defined in: [webrtc/src/transport/sctp.ts:34](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/transport/sctp.ts#L34)

## Properties

### bundled

• **bundled**: *boolean*= false

Defined in: [webrtc/src/transport/sctp.ts:30](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/transport/sctp.ts#L30)

___

### dataChannelId

• `Private` `Optional` **dataChannelId**: *number*

Defined in: [webrtc/src/transport/sctp.ts:34](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/transport/sctp.ts#L34)

___

### dataChannelQueue

• `Private` **dataChannelQueue**: [[*RTCDataChannel*](rtcdatachannel.md), *number*, *Buffer*][]= []

Defined in: [webrtc/src/transport/sctp.ts:33](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/transport/sctp.ts#L33)

___

### dataChannels

• **dataChannels**: *object*= {}

#### Type declaration:

Defined in: [webrtc/src/transport/sctp.ts:31](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/transport/sctp.ts#L31)

___

### dtlsTransport

• **dtlsTransport**: [*RTCDtlsTransport*](rtcdtlstransport.md)

___

### mid

• `Optional` **mid**: *string*

Defined in: [webrtc/src/transport/sctp.ts:29](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/transport/sctp.ts#L29)

___

### onDataChannel

• `Readonly` **onDataChannel**: *default*<[[*RTCDataChannel*](rtcdatachannel.md)]\>

Defined in: [webrtc/src/transport/sctp.ts:26](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/transport/sctp.ts#L26)

___

### port

• **port**: *number*= 5000

___

### sctp

• `Readonly` **sctp**: *SCTP*

Defined in: [webrtc/src/transport/sctp.ts:28](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/transport/sctp.ts#L28)

___

### uuid

• `Readonly` **uuid**: *string*

Defined in: [webrtc/src/transport/sctp.ts:27](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/transport/sctp.ts#L27)

## Accessors

### isServer

• `Private`get **isServer**(): *boolean*

**Returns:** *boolean*

Defined in: [webrtc/src/transport/sctp.ts:73](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/transport/sctp.ts#L73)

## Methods

### channelByLabel

▸ **channelByLabel**(`label`: *string*): *undefined* \| [*RTCDataChannel*](rtcdatachannel.md)

#### Parameters:

Name | Type |
:------ | :------ |
`label` | *string* |

**Returns:** *undefined* \| [*RTCDataChannel*](rtcdatachannel.md)

Defined in: [webrtc/src/transport/sctp.ts:77](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/transport/sctp.ts#L77)

___

### dataChannelAddNegotiated

▸ **dataChannelAddNegotiated**(`channel`: [*RTCDataChannel*](rtcdatachannel.md)): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`channel` | [*RTCDataChannel*](rtcdatachannel.md) |

**Returns:** *void*

Defined in: [webrtc/src/transport/sctp.ts:178](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/transport/sctp.ts#L178)

___

### dataChannelClose

▸ **dataChannelClose**(`channel`: [*RTCDataChannel*](rtcdatachannel.md)): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`channel` | [*RTCDataChannel*](rtcdatachannel.md) |

**Returns:** *void*

Defined in: [webrtc/src/transport/sctp.ts:316](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/transport/sctp.ts#L316)

___

### dataChannelFlush

▸ `Private`**dataChannelFlush**(): *Promise*<void\>

**Returns:** *Promise*<void\>

Defined in: [webrtc/src/transport/sctp.ts:235](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/transport/sctp.ts#L235)

___

### dataChannelOpen

▸ **dataChannelOpen**(`channel`: [*RTCDataChannel*](rtcdatachannel.md)): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`channel` | [*RTCDataChannel*](rtcdatachannel.md) |

**Returns:** *void*

Defined in: [webrtc/src/transport/sctp.ts:193](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/transport/sctp.ts#L193)

___

### datachannelReceive

▸ `Private`**datachannelReceive**(`streamId`: *number*, `ppId`: *number*, `data`: *Buffer*): *Promise*<void\>

#### Parameters:

Name | Type |
:------ | :------ |
`streamId` | *number* |
`ppId` | *number* |
`data` | *Buffer* |

**Returns:** *Promise*<void\>

Defined in: [webrtc/src/transport/sctp.ts:81](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/transport/sctp.ts#L81)

___

### datachannelSend

▸ **datachannelSend**(`channel`: [*RTCDataChannel*](rtcdatachannel.md), `data`: *string* \| *Buffer*): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`channel` | [*RTCDataChannel*](rtcdatachannel.md) |
`data` | *string* \| *Buffer* |

**Returns:** *void*

Defined in: [webrtc/src/transport/sctp.ts:280](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/transport/sctp.ts#L280)

___

### start

▸ **start**(`remotePort`: *number*): *Promise*<void\>

#### Parameters:

Name | Type |
:------ | :------ |
`remotePort` | *number* |

**Returns:** *Promise*<void\>

Defined in: [webrtc/src/transport/sctp.ts:300](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/transport/sctp.ts#L300)

___

### stop

▸ **stop**(): *Promise*<void\>

**Returns:** *Promise*<void\>

Defined in: [webrtc/src/transport/sctp.ts:311](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/transport/sctp.ts#L311)

___

### getCapabilities

▸ `Static`**getCapabilities**(): *RTCSctpCapabilities*

**Returns:** *RTCSctpCapabilities*

Defined in: [webrtc/src/transport/sctp.ts:296](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/transport/sctp.ts#L296)

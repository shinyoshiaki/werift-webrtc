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

\+ **new RTCSctpTransport**(`dtlsTransport`: *RTCDtlsTransport*, `port?`: *number*): [*RTCSctpTransport*](rtcsctptransport.md)

#### Parameters:

Name | Type | Default value |
:------ | :------ | :------ |
`dtlsTransport` | *RTCDtlsTransport* | - |
`port` | *number* | 5000 |

**Returns:** [*RTCSctpTransport*](rtcsctptransport.md)

Defined in: [webrtc/src/transport/sctp.ts:32](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/webrtc/src/transport/sctp.ts#L32)

## Properties

### bundled

• **bundled**: *boolean*= false

Defined in: [webrtc/src/transport/sctp.ts:23](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/webrtc/src/transport/sctp.ts#L23)

___

### dataChannelId

• `Private` `Optional` **dataChannelId**: *undefined* \| *number*

Defined in: [webrtc/src/transport/sctp.ts:32](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/webrtc/src/transport/sctp.ts#L32)

___

### dataChannelQueue

• `Private` **dataChannelQueue**: [[*RTCDataChannel*](rtcdatachannel.md), *number*, *Buffer*, *undefined* \| *default*<any\>][]

Defined in: [webrtc/src/transport/sctp.ts:26](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/webrtc/src/transport/sctp.ts#L26)

___

### dataChannels

• **dataChannels**: *object*

#### Type declaration:

Defined in: [webrtc/src/transport/sctp.ts:24](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/webrtc/src/transport/sctp.ts#L24)

___

### dtlsTransport

• **dtlsTransport**: *RTCDtlsTransport*

___

### mid

• `Optional` **mid**: *undefined* \| *string*

Defined in: [webrtc/src/transport/sctp.ts:22](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/webrtc/src/transport/sctp.ts#L22)

___

### onDataChannel

• `Readonly` **onDataChannel**: *default*<[[*RTCDataChannel*](rtcdatachannel.md)]\>

Defined in: [webrtc/src/transport/sctp.ts:19](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/webrtc/src/transport/sctp.ts#L19)

___

### port

• **port**: *number*= 5000

___

### sctp

• `Readonly` **sctp**: *SCTP*

Defined in: [webrtc/src/transport/sctp.ts:21](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/webrtc/src/transport/sctp.ts#L21)

___

### uuid

• `Readonly` **uuid**: *string*

Defined in: [webrtc/src/transport/sctp.ts:20](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/webrtc/src/transport/sctp.ts#L20)

## Accessors

### isServer

• `Private`get **isServer**(): *boolean*

**Returns:** *boolean*

Defined in: [webrtc/src/transport/sctp.ts:69](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/webrtc/src/transport/sctp.ts#L69)

## Methods

### channelByLabel

▸ **channelByLabel**(`label`: *string*): *undefined* \| [*RTCDataChannel*](rtcdatachannel.md)

#### Parameters:

Name | Type |
:------ | :------ |
`label` | *string* |

**Returns:** *undefined* \| [*RTCDataChannel*](rtcdatachannel.md)

Defined in: [webrtc/src/transport/sctp.ts:73](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/webrtc/src/transport/sctp.ts#L73)

___

### dataChannelAddNegotiated

▸ **dataChannelAddNegotiated**(`channel`: [*RTCDataChannel*](rtcdatachannel.md)): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`channel` | [*RTCDataChannel*](rtcdatachannel.md) |

**Returns:** *void*

Defined in: [webrtc/src/transport/sctp.ts:161](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/webrtc/src/transport/sctp.ts#L161)

___

### dataChannelClose

▸ **dataChannelClose**(`channel`: [*RTCDataChannel*](rtcdatachannel.md)): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`channel` | [*RTCDataChannel*](rtcdatachannel.md) |

**Returns:** *void*

Defined in: [webrtc/src/transport/sctp.ts:311](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/webrtc/src/transport/sctp.ts#L311)

___

### dataChannelFlush

▸ `Private`**dataChannelFlush**(): *void*

**Returns:** *void*

Defined in: [webrtc/src/transport/sctp.ts:214](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/webrtc/src/transport/sctp.ts#L214)

___

### dataChannelOpen

▸ **dataChannelOpen**(`channel`: [*RTCDataChannel*](rtcdatachannel.md)): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`channel` | [*RTCDataChannel*](rtcdatachannel.md) |

**Returns:** *void*

Defined in: [webrtc/src/transport/sctp.ts:172](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/webrtc/src/transport/sctp.ts#L172)

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

Defined in: [webrtc/src/transport/sctp.ts:77](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/webrtc/src/transport/sctp.ts#L77)

___

### datachannelSend

▸ **datachannelSend**(`channel`: [*RTCDataChannel*](rtcdatachannel.md), `data`: *string* \| *Buffer*): *Promise*<unknown\>

#### Parameters:

Name | Type |
:------ | :------ |
`channel` | [*RTCDataChannel*](rtcdatachannel.md) |
`data` | *string* \| *Buffer* |

**Returns:** *Promise*<unknown\>

Defined in: [webrtc/src/transport/sctp.ts:269](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/webrtc/src/transport/sctp.ts#L269)

___

### start

▸ **start**(`remotePort`: *number*): *Promise*<void\>

#### Parameters:

Name | Type |
:------ | :------ |
`remotePort` | *number* |

**Returns:** *Promise*<void\>

Defined in: [webrtc/src/transport/sctp.ts:295](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/webrtc/src/transport/sctp.ts#L295)

___

### stop

▸ **stop**(): *void*

**Returns:** *void*

Defined in: [webrtc/src/transport/sctp.ts:306](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/webrtc/src/transport/sctp.ts#L306)

___

### getCapabilities

▸ `Static`**getCapabilities**(): *RTCSctpCapabilities*

**Returns:** *RTCSctpCapabilities*

Defined in: [webrtc/src/transport/sctp.ts:291](https://github.com/shinyoshiaki/werift-webrtc/blob/9b1b713/packages/webrtc/src/transport/sctp.ts#L291)

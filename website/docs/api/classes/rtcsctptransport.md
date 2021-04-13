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

Defined in: [webrtc/src/transport/sctp.ts:39](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/transport/sctp.ts#L39)

## Properties

### bundled

• **bundled**: *boolean*= false

Defined in: [webrtc/src/transport/sctp.ts:30](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/transport/sctp.ts#L30)

___

### dataChannelId

• `Private` `Optional` **dataChannelId**: *number*

Defined in: [webrtc/src/transport/sctp.ts:39](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/transport/sctp.ts#L39)

___

### dataChannelQueue

• `Private` **dataChannelQueue**: [[*RTCDataChannel*](rtcdatachannel.md), *number*, *Buffer*, *undefined* \| *default*<any\>][]= []

Defined in: [webrtc/src/transport/sctp.ts:33](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/transport/sctp.ts#L33)

___

### dataChannels

• **dataChannels**: *object*= {}

#### Type declaration:

Defined in: [webrtc/src/transport/sctp.ts:31](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/transport/sctp.ts#L31)

___

### dtlsTransport

• **dtlsTransport**: [*RTCDtlsTransport*](rtcdtlstransport.md)

___

### mid

• `Optional` **mid**: *string*

Defined in: [webrtc/src/transport/sctp.ts:29](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/transport/sctp.ts#L29)

___

### onDataChannel

• `Readonly` **onDataChannel**: *default*<[[*RTCDataChannel*](rtcdatachannel.md)]\>

Defined in: [webrtc/src/transport/sctp.ts:26](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/transport/sctp.ts#L26)

___

### port

• **port**: *number*= 5000

___

### sctp

• `Readonly` **sctp**: *SCTP*

Defined in: [webrtc/src/transport/sctp.ts:28](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/transport/sctp.ts#L28)

___

### uuid

• `Readonly` **uuid**: *string*

Defined in: [webrtc/src/transport/sctp.ts:27](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/transport/sctp.ts#L27)

## Accessors

### isServer

• `Private`get **isServer**(): *boolean*

**Returns:** *boolean*

Defined in: [webrtc/src/transport/sctp.ts:75](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/transport/sctp.ts#L75)

## Methods

### channelByLabel

▸ **channelByLabel**(`label`: *string*): *undefined* \| [*RTCDataChannel*](rtcdatachannel.md)

#### Parameters:

Name | Type |
:------ | :------ |
`label` | *string* |

**Returns:** *undefined* \| [*RTCDataChannel*](rtcdatachannel.md)

Defined in: [webrtc/src/transport/sctp.ts:79](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/transport/sctp.ts#L79)

___

### dataChannelAddNegotiated

▸ **dataChannelAddNegotiated**(`channel`: [*RTCDataChannel*](rtcdatachannel.md)): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`channel` | [*RTCDataChannel*](rtcdatachannel.md) |

**Returns:** *void*

Defined in: [webrtc/src/transport/sctp.ts:180](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/transport/sctp.ts#L180)

___

### dataChannelClose

▸ **dataChannelClose**(`channel`: [*RTCDataChannel*](rtcdatachannel.md)): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`channel` | [*RTCDataChannel*](rtcdatachannel.md) |

**Returns:** *void*

Defined in: [webrtc/src/transport/sctp.ts:334](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/transport/sctp.ts#L334)

___

### dataChannelFlush

▸ `Private`**dataChannelFlush**(): *void*

**Returns:** *void*

Defined in: [webrtc/src/transport/sctp.ts:237](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/transport/sctp.ts#L237)

___

### dataChannelOpen

▸ **dataChannelOpen**(`channel`: [*RTCDataChannel*](rtcdatachannel.md)): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`channel` | [*RTCDataChannel*](rtcdatachannel.md) |

**Returns:** *void*

Defined in: [webrtc/src/transport/sctp.ts:195](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/transport/sctp.ts#L195)

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

Defined in: [webrtc/src/transport/sctp.ts:83](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/transport/sctp.ts#L83)

___

### datachannelSend

▸ **datachannelSend**(`channel`: [*RTCDataChannel*](rtcdatachannel.md), `data`: *string* \| *Buffer*): *Promise*<unknown\>

#### Parameters:

Name | Type |
:------ | :------ |
`channel` | [*RTCDataChannel*](rtcdatachannel.md) |
`data` | *string* \| *Buffer* |

**Returns:** *Promise*<unknown\>

Defined in: [webrtc/src/transport/sctp.ts:292](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/transport/sctp.ts#L292)

___

### start

▸ **start**(`remotePort`: *number*): *Promise*<void\>

#### Parameters:

Name | Type |
:------ | :------ |
`remotePort` | *number* |

**Returns:** *Promise*<void\>

Defined in: [webrtc/src/transport/sctp.ts:318](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/transport/sctp.ts#L318)

___

### stop

▸ **stop**(): *void*

**Returns:** *void*

Defined in: [webrtc/src/transport/sctp.ts:329](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/transport/sctp.ts#L329)

___

### getCapabilities

▸ `Static`**getCapabilities**(): *RTCSctpCapabilities*

**Returns:** *RTCSctpCapabilities*

Defined in: [webrtc/src/transport/sctp.ts:314](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/transport/sctp.ts#L314)

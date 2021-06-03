---
id: "rtcsctptransport"
title: "Class: RTCSctpTransport"
sidebar_label: "RTCSctpTransport"
sidebar_position: 0
custom_edit_url: null
---

## Constructors

### constructor

• **new RTCSctpTransport**(`dtlsTransport`, `port?`)

#### Parameters

| Name | Type | Default value |
| :------ | :------ | :------ |
| `dtlsTransport` | [RTCDtlsTransport](rtcdtlstransport.md) | `undefined` |
| `port` | `number` | 5000 |

#### Defined in

[packages/webrtc/src/transport/sctp.ts:35](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/sctp.ts#L35)

## Properties

### bundled

• **bundled**: `boolean` = false

#### Defined in

[packages/webrtc/src/transport/sctp.ts:31](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/sctp.ts#L31)

___

### dataChannelId

• `Private` `Optional` **dataChannelId**: `number`

#### Defined in

[packages/webrtc/src/transport/sctp.ts:35](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/sctp.ts#L35)

___

### dataChannelQueue

• `Private` **dataChannelQueue**: [[RTCDataChannel](rtcdatachannel.md), `number`, `Buffer`][] = []

#### Defined in

[packages/webrtc/src/transport/sctp.ts:34](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/sctp.ts#L34)

___

### dataChannels

• **dataChannels**: `Object` = {}

#### Index signature

▪ [key: `number`]: [RTCDataChannel](rtcdatachannel.md)

#### Defined in

[packages/webrtc/src/transport/sctp.ts:32](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/sctp.ts#L32)

___

### dtlsTransport

• **dtlsTransport**: [RTCDtlsTransport](rtcdtlstransport.md)

___

### mid

• `Optional` **mid**: `string`

#### Defined in

[packages/webrtc/src/transport/sctp.ts:30](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/sctp.ts#L30)

___

### onDataChannel

• `Readonly` **onDataChannel**: `default`<[[RTCDataChannel](rtcdatachannel.md)]\>

#### Defined in

[packages/webrtc/src/transport/sctp.ts:27](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/sctp.ts#L27)

___

### port

• **port**: `number` = 5000

___

### sctp

• `Readonly` **sctp**: `SCTP`

#### Defined in

[packages/webrtc/src/transport/sctp.ts:29](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/sctp.ts#L29)

___

### uuid

• `Readonly` **uuid**: `string`

#### Defined in

[packages/webrtc/src/transport/sctp.ts:28](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/sctp.ts#L28)

## Accessors

### isServer

• `Private` `get` **isServer**(): `boolean`

#### Returns

`boolean`

#### Defined in

[packages/webrtc/src/transport/sctp.ts:74](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/sctp.ts#L74)

## Methods

### channelByLabel

▸ **channelByLabel**(`label`): `undefined` \| [RTCDataChannel](rtcdatachannel.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `label` | `string` |

#### Returns

`undefined` \| [RTCDataChannel](rtcdatachannel.md)

#### Defined in

[packages/webrtc/src/transport/sctp.ts:78](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/sctp.ts#L78)

___

### dataChannelAddNegotiated

▸ **dataChannelAddNegotiated**(`channel`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `channel` | [RTCDataChannel](rtcdatachannel.md) |

#### Returns

`void`

#### Defined in

[packages/webrtc/src/transport/sctp.ts:181](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/sctp.ts#L181)

___

### dataChannelClose

▸ **dataChannelClose**(`channel`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `channel` | [RTCDataChannel](rtcdatachannel.md) |

#### Returns

`void`

#### Defined in

[packages/webrtc/src/transport/sctp.ts:319](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/sctp.ts#L319)

___

### dataChannelFlush

▸ `Private` **dataChannelFlush**(): `Promise`<void\>

#### Returns

`Promise`<void\>

#### Defined in

[packages/webrtc/src/transport/sctp.ts:238](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/sctp.ts#L238)

___

### dataChannelOpen

▸ **dataChannelOpen**(`channel`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `channel` | [RTCDataChannel](rtcdatachannel.md) |

#### Returns

`void`

#### Defined in

[packages/webrtc/src/transport/sctp.ts:196](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/sctp.ts#L196)

___

### datachannelReceive

▸ `Private` **datachannelReceive**(`streamId`, `ppId`, `data`): `Promise`<void\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `streamId` | `number` |
| `ppId` | `number` |
| `data` | `Buffer` |

#### Returns

`Promise`<void\>

#### Defined in

[packages/webrtc/src/transport/sctp.ts:82](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/sctp.ts#L82)

___

### datachannelSend

▸ **datachannelSend**(`channel`, `data`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `channel` | [RTCDataChannel](rtcdatachannel.md) |
| `data` | `string` \| `Buffer` |

#### Returns

`void`

#### Defined in

[packages/webrtc/src/transport/sctp.ts:283](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/sctp.ts#L283)

___

### start

▸ **start**(`remotePort`): `Promise`<void\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `remotePort` | `number` |

#### Returns

`Promise`<void\>

#### Defined in

[packages/webrtc/src/transport/sctp.ts:303](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/sctp.ts#L303)

___

### stop

▸ **stop**(): `Promise`<void\>

#### Returns

`Promise`<void\>

#### Defined in

[packages/webrtc/src/transport/sctp.ts:314](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/sctp.ts#L314)

___

### getCapabilities

▸ `Static` **getCapabilities**(): `RTCSctpCapabilities`

#### Returns

`RTCSctpCapabilities`

#### Defined in

[packages/webrtc/src/transport/sctp.ts:299](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/transport/sctp.ts#L299)

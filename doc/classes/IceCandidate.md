[werift](../README.md) / [Exports](../modules.md) / IceCandidate

# Class: IceCandidate

## Table of contents

### Constructors

- [constructor](IceCandidate.md#constructor)

### Properties

- [component](IceCandidate.md#component)
- [foundation](IceCandidate.md#foundation)
- [ip](IceCandidate.md#ip)
- [port](IceCandidate.md#port)
- [priority](IceCandidate.md#priority)
- [protocol](IceCandidate.md#protocol)
- [relatedAddress](IceCandidate.md#relatedaddress)
- [relatedPort](IceCandidate.md#relatedport)
- [sdpMLineIndex](IceCandidate.md#sdpmlineindex)
- [sdpMid](IceCandidate.md#sdpmid)
- [tcpType](IceCandidate.md#tcptype)
- [type](IceCandidate.md#type)

### Methods

- [toJSON](IceCandidate.md#tojson)
- [fromJSON](IceCandidate.md#fromjson)

## Constructors

### constructor

• **new IceCandidate**(`component`, `foundation`, `ip`, `port`, `priority`, `protocol`, `type`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `component` | `number` |
| `foundation` | `string` |
| `ip` | `string` |
| `port` | `number` |
| `priority` | `number` |
| `protocol` | `string` |
| `type` | `string` |

#### Defined in

[packages/webrtc/src/transport/ice.ts:209](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/ice.ts#L209)

## Properties

### component

• **component**: `number`

#### Defined in

[packages/webrtc/src/transport/ice.ts:210](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/ice.ts#L210)

___

### foundation

• **foundation**: `string`

#### Defined in

[packages/webrtc/src/transport/ice.ts:211](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/ice.ts#L211)

___

### ip

• **ip**: `string`

#### Defined in

[packages/webrtc/src/transport/ice.ts:212](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/ice.ts#L212)

___

### port

• **port**: `number`

#### Defined in

[packages/webrtc/src/transport/ice.ts:213](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/ice.ts#L213)

___

### priority

• **priority**: `number`

#### Defined in

[packages/webrtc/src/transport/ice.ts:214](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/ice.ts#L214)

___

### protocol

• **protocol**: `string`

#### Defined in

[packages/webrtc/src/transport/ice.ts:215](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/ice.ts#L215)

___

### relatedAddress

• `Optional` **relatedAddress**: `string`

#### Defined in

[packages/webrtc/src/transport/ice.ts:203](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/ice.ts#L203)

___

### relatedPort

• `Optional` **relatedPort**: `number`

#### Defined in

[packages/webrtc/src/transport/ice.ts:204](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/ice.ts#L204)

___

### sdpMLineIndex

• `Optional` **sdpMLineIndex**: `number`

#### Defined in

[packages/webrtc/src/transport/ice.ts:206](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/ice.ts#L206)

___

### sdpMid

• `Optional` **sdpMid**: `string`

#### Defined in

[packages/webrtc/src/transport/ice.ts:205](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/ice.ts#L205)

___

### tcpType

• `Optional` **tcpType**: `string`

#### Defined in

[packages/webrtc/src/transport/ice.ts:207](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/ice.ts#L207)

___

### type

• **type**: `string`

#### Defined in

[packages/webrtc/src/transport/ice.ts:216](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/ice.ts#L216)

## Methods

### toJSON

▸ **toJSON**(): [`RTCIceCandidate`](RTCIceCandidate.md)

#### Returns

[`RTCIceCandidate`](RTCIceCandidate.md)

#### Defined in

[packages/webrtc/src/transport/ice.ts:219](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/ice.ts#L219)

___

### fromJSON

▸ `Static` **fromJSON**(`data`): `undefined` \| [`IceCandidate`](IceCandidate.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | [`RTCIceCandidate`](RTCIceCandidate.md) |

#### Returns

`undefined` \| [`IceCandidate`](IceCandidate.md)

#### Defined in

[packages/webrtc/src/transport/ice.ts:227](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/ice.ts#L227)

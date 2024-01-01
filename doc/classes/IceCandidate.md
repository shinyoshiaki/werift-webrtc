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

• **new IceCandidate**(`component`, `foundation`, `ip`, `port`, `priority`, `protocol`, `type`): [`IceCandidate`](IceCandidate.md)

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

#### Returns

[`IceCandidate`](IceCandidate.md)

## Properties

### component

• **component**: `number`

___

### foundation

• **foundation**: `string`

___

### ip

• **ip**: `string`

___

### port

• **port**: `number`

___

### priority

• **priority**: `number`

___

### protocol

• **protocol**: `string`

___

### relatedAddress

• `Optional` **relatedAddress**: `string`

___

### relatedPort

• `Optional` **relatedPort**: `number`

___

### sdpMLineIndex

• `Optional` **sdpMLineIndex**: `number`

___

### sdpMid

• `Optional` **sdpMid**: `string`

___

### tcpType

• `Optional` **tcpType**: `string`

___

### type

• **type**: `string`

## Methods

### toJSON

▸ **toJSON**(): [`RTCIceCandidate`](RTCIceCandidate.md)

#### Returns

[`RTCIceCandidate`](RTCIceCandidate.md)

___

### fromJSON

▸ **fromJSON**(`data`): `undefined` \| [`IceCandidate`](IceCandidate.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | [`RTCIceCandidate`](RTCIceCandidate.md) |

#### Returns

`undefined` \| [`IceCandidate`](IceCandidate.md)

[werift-rtp](../README.md) / [Exports](../modules.md) / RtpSourceStream

# Class: RtpSourceStream

## Table of contents

### Constructors

- [constructor](RtpSourceStream.md#constructor)

### Properties

- [controller](RtpSourceStream.md#controller)
- [readable](RtpSourceStream.md#readable)
- [write](RtpSourceStream.md#write)

### Methods

- [push](RtpSourceStream.md#push)
- [stop](RtpSourceStream.md#stop)

## Constructors

### constructor

• **new RtpSourceStream**(`options?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `options` | `Object` |
| `options.clearInvalidPTPacket?` | `boolean` |
| `options.payloadType?` | `number` |

## Properties

### controller

• `Protected` **controller**: `ReadableStreamController`<[`RtpOutput`](../interfaces/RtpOutput.md)\>

___

### readable

• **readable**: `ReadableStream`<[`RtpOutput`](../interfaces/RtpOutput.md)\>

___

### write

• **write**: (`chunk`: [`RtpOutput`](../interfaces/RtpOutput.md)) => `void`

#### Type declaration

▸ (`chunk`): `void`

##### Parameters

| Name | Type |
| :------ | :------ |
| `chunk` | [`RtpOutput`](../interfaces/RtpOutput.md) |

##### Returns

`void`

## Methods

### push

▸ **push**(`packet`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `packet` | `Buffer` \| [`RtpPacket`](RtpPacket.md) |

#### Returns

`void`

___

### stop

▸ **stop**(): `void`

#### Returns

`void`

[werift-rtp](../README.md) / [Exports](../modules.md) / RtpSourceStream

# Class: RtpSourceStream

## Hierarchy

- `SourceStream`<`RtpOutput`\>

  ↳ **`RtpSourceStream`**

## Table of contents

### Constructors

- [constructor](RtpSourceStream.md#constructor)

### Properties

- [controller](RtpSourceStream.md#controller)
- [readable](RtpSourceStream.md#readable)
- [write](RtpSourceStream.md#write)

### Methods

- [stop](RtpSourceStream.md#stop)

## Constructors

### constructor

• **new RtpSourceStream**(`ev`, `options?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `ev` | `Event`<[[`RtpPacket`](RtpPacket.md)]\> |
| `options` | `Object` |
| `options.payloadType?` | `number` |

#### Overrides

SourceStream&lt;RtpOutput\&gt;.constructor

## Properties

### controller

• `Protected` **controller**: `ReadableStreamController`<`RtpOutput`\>

#### Inherited from

SourceStream.controller

___

### readable

• **readable**: `ReadableStream`<`RtpOutput`\>

#### Inherited from

SourceStream.readable

___

### write

• **write**: (`chunk`: `RtpOutput`) => `void`

#### Type declaration

▸ (`chunk`): `void`

##### Parameters

| Name | Type |
| :------ | :------ |
| `chunk` | `RtpOutput` |

##### Returns

`void`

#### Inherited from

SourceStream.write

## Methods

### stop

▸ **stop**(): `Promise`<`void`\>

#### Returns

`Promise`<`void`\>

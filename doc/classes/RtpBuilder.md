[werift](../README.md) / [Exports](../modules.md) / RtpBuilder

# Class: RtpBuilder

## Table of contents

### Constructors

- [constructor](RtpBuilder.md#constructor)

### Properties

- [sequenceNumber](RtpBuilder.md#sequencenumber)
- [timestamp](RtpBuilder.md#timestamp)

### Methods

- [create](RtpBuilder.md#create)

## Constructors

### constructor

• **new RtpBuilder**()

## Properties

### sequenceNumber

• **sequenceNumber**: `number`

#### Defined in

[packages/webrtc/src/utils.ts:113](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/utils.ts#L113)

___

### timestamp

• **timestamp**: `number`

#### Defined in

[packages/webrtc/src/utils.ts:114](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/utils.ts#L114)

## Methods

### create

▸ **create**(`payload`): [`RtpPacket`](RtpPacket.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `payload` | `Buffer` |

#### Returns

[`RtpPacket`](RtpPacket.md)

#### Defined in

[packages/webrtc/src/utils.ts:116](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/utils.ts#L116)

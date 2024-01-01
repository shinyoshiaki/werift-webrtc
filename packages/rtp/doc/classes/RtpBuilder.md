[werift-rtp](../README.md) / [Exports](../modules.md) / RtpBuilder

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

• **new RtpBuilder**(`props`): [`RtpBuilder`](RtpBuilder.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Object` |
| `props.between` | `number` |
| `props.clockRate` | `number` |

#### Returns

[`RtpBuilder`](RtpBuilder.md)

## Properties

### sequenceNumber

• **sequenceNumber**: `any`

___

### timestamp

• **timestamp**: `any`

## Methods

### create

▸ **create**(`payload`): [`RtpPacket`](RtpPacket.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `payload` | `Buffer` |

#### Returns

[`RtpPacket`](RtpPacket.md)

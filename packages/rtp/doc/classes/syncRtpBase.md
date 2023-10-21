[werift-rtp](../README.md) / [Exports](../modules.md) / syncRtpBase

# Class: syncRtpBase

## Hierarchy

- **`syncRtpBase`**

  ↳ [`NtpTimeCallback`](NtpTimeCallback.md)

## Implements

- `Processor`<[`NtpTimeInput`](../modules.md#ntptimeinput), [`NtpTimeOutput`](../interfaces/NtpTimeOutput.md)\>

## Table of contents

### Constructors

- [constructor](syncRtpBase.md#constructor)

### Properties

- [buffer](syncRtpBase.md#buffer)
- [clockRate](syncRtpBase.md#clockrate)
- [ntpTimestamp](syncRtpBase.md#ntptimestamp)
- [rtpTimestamp](syncRtpBase.md#rtptimestamp)

### Methods

- [processInput](syncRtpBase.md#processinput)

## Constructors

### constructor

• **new syncRtpBase**(`clockRate`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `clockRate` | `number` |

## Properties

### buffer

• **buffer**: [`RtpPacket`](RtpPacket.md)[] = `[]`

___

### clockRate

• **clockRate**: `number`

___

### ntpTimestamp

• `Optional` **ntpTimestamp**: `bigint`

___

### rtpTimestamp

• `Optional` **rtpTimestamp**: `number`

## Methods

### processInput

▸ **processInput**(`«destructured»`): [`NtpTimeOutput`](../interfaces/NtpTimeOutput.md)[]

#### Parameters

| Name | Type |
| :------ | :------ |
| `«destructured»` | [`NtpTimeInput`](../modules.md#ntptimeinput) |

#### Returns

[`NtpTimeOutput`](../interfaces/NtpTimeOutput.md)[]

#### Implementation of

Processor.processInput

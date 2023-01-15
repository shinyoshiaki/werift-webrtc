[werift](../README.md) / [Exports](../modules.md) / NtpTimeCallback

# Class: NtpTimeCallback

## Hierarchy

- [`syncRtpBase`](syncRtpBase.md)

  ↳ **`NtpTimeCallback`**

## Table of contents

### Constructors

- [constructor](NtpTimeCallback.md#constructor)

### Properties

- [buffer](NtpTimeCallback.md#buffer)
- [clockRate](NtpTimeCallback.md#clockrate)
- [ntpTimestamp](NtpTimeCallback.md#ntptimestamp)
- [rtpTimestamp](NtpTimeCallback.md#rtptimestamp)

### Methods

- [input](NtpTimeCallback.md#input)
- [pipe](NtpTimeCallback.md#pipe)
- [processInput](NtpTimeCallback.md#processinput)

## Constructors

### constructor

• **new NtpTimeCallback**(`clockRate`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `clockRate` | `number` |

#### Overrides

[syncRtpBase](syncRtpBase.md).[constructor](syncRtpBase.md#constructor)

## Properties

### buffer

• **buffer**: [`RtpPacket`](RtpPacket.md)[] = `[]`

#### Inherited from

[syncRtpBase](syncRtpBase.md).[buffer](syncRtpBase.md#buffer)

___

### clockRate

• **clockRate**: `number`

#### Inherited from

[syncRtpBase](syncRtpBase.md).[clockRate](syncRtpBase.md#clockrate)

___

### ntpTimestamp

• `Optional` **ntpTimestamp**: `bigint`

#### Inherited from

[syncRtpBase](syncRtpBase.md).[ntpTimestamp](syncRtpBase.md#ntptimestamp)

___

### rtpTimestamp

• `Optional` **rtpTimestamp**: `number`

#### Inherited from

[syncRtpBase](syncRtpBase.md).[rtpTimestamp](syncRtpBase.md#rtptimestamp)

## Methods

### input

▸ **input**(`input`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `input` | [`NtpTimeInput`](../modules.md#ntptimeinput) |

#### Returns

`void`

___

### pipe

▸ **pipe**(`cb`): `this`

#### Parameters

| Name | Type |
| :------ | :------ |
| `cb` | (`input`: [`NtpTimeOutput`](../interfaces/NtpTimeOutput.md)) => `void` |

#### Returns

`this`

___

### processInput

▸ **processInput**(`«destructured»`): [`NtpTimeOutput`](../interfaces/NtpTimeOutput.md)[]

#### Parameters

| Name | Type |
| :------ | :------ |
| `«destructured»` | [`NtpTimeInput`](../modules.md#ntptimeinput) |

#### Returns

[`NtpTimeOutput`](../interfaces/NtpTimeOutput.md)[]

#### Inherited from

[syncRtpBase](syncRtpBase.md).[processInput](syncRtpBase.md#processinput)

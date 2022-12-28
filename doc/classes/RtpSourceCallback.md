[werift](../README.md) / [Exports](../modules.md) / RtpSourceCallback

# Class: RtpSourceCallback

## Table of contents

### Constructors

- [constructor](RtpSourceCallback.md#constructor)

### Methods

- [input](RtpSourceCallback.md#input)
- [pipe](RtpSourceCallback.md#pipe)
- [stop](RtpSourceCallback.md#stop)

## Constructors

### constructor

• **new RtpSourceCallback**(`options?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `options` | `Object` |
| `options.clearInvalidPTPacket?` | `boolean` |
| `options.payloadType?` | `number` |

## Methods

### input

▸ **input**(`packet`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `packet` | `Buffer` \| [`RtpPacket`](RtpPacket.md) |

#### Returns

`void`

___

### pipe

▸ **pipe**(`cb`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `cb` | (`chunk`: [`RtpOutput`](../interfaces/RtpOutput.md)) => `void` |

#### Returns

`void`

___

### stop

▸ **stop**(): `void`

#### Returns

`void`

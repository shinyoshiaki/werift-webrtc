[werift](../README.md) / [Exports](../modules.md) / RtcpSourceCallback

# Class: RtcpSourceCallback

## Table of contents

### Constructors

- [constructor](RtcpSourceCallback.md#constructor)

### Methods

- [input](RtcpSourceCallback.md#input)
- [pipe](RtcpSourceCallback.md#pipe)
- [stop](RtcpSourceCallback.md#stop)

## Constructors

### constructor

• **new RtcpSourceCallback**()

## Methods

### input

▸ **input**(`rtcp`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `rtcp` | [`RtcpPacket`](../modules.md#rtcppacket) |

#### Returns

`void`

___

### pipe

▸ **pipe**(`cb`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `cb` | (`chunk`: [`RtcpOutput`](../interfaces/RtcpOutput.md)) => `void` |

#### Returns

`void`

___

### stop

▸ **stop**(): `void`

#### Returns

`void`

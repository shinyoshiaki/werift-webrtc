[werift](../README.md) / [Exports](../modules.md) / JitterBufferOutput

# Interface: JitterBufferOutput

## Hierarchy

- [`RtpOutput`](RtpOutput.md)

  ↳ **`JitterBufferOutput`**

## Table of contents

### Properties

- [eol](JitterBufferOutput.md#eol)
- [isPacketLost](JitterBufferOutput.md#ispacketlost)
- [rtp](JitterBufferOutput.md#rtp)

## Properties

### eol

• `Optional` **eol**: `boolean`

#### Inherited from

[RtpOutput](RtpOutput.md).[eol](RtpOutput.md#eol)

___

### isPacketLost

• `Optional` **isPacketLost**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `from` | `number` |
| `to` | `number` |

___

### rtp

• `Optional` **rtp**: [`RtpPacket`](../classes/RtpPacket.md)

#### Inherited from

[RtpOutput](RtpOutput.md).[rtp](RtpOutput.md#rtp)

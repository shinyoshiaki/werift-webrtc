[werift](../README.md) / [Exports](../modules.md) / JitterBufferOutput

# Interface: JitterBufferOutput

## Hierarchy

- `RtpOutput`

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

RtpOutput.eol

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

RtpOutput.rtp

[werift](../README.md) / [Exports](../modules.md) / RtcpReceiverInfo

# Class: RtcpReceiverInfo

## Table of contents

### Constructors

- [constructor](RtcpReceiverInfo.md#constructor)

### Properties

- [dlsr](RtcpReceiverInfo.md#dlsr)
- [fractionLost](RtcpReceiverInfo.md#fractionlost)
- [highestSequence](RtcpReceiverInfo.md#highestsequence)
- [jitter](RtcpReceiverInfo.md#jitter)
- [lsr](RtcpReceiverInfo.md#lsr)
- [packetsLost](RtcpReceiverInfo.md#packetslost)
- [ssrc](RtcpReceiverInfo.md#ssrc)

### Methods

- [serialize](RtcpReceiverInfo.md#serialize)
- [deSerialize](RtcpReceiverInfo.md#deserialize)

## Constructors

### constructor

• **new RtcpReceiverInfo**(`props?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`<[`RtcpReceiverInfo`](RtcpReceiverInfo.md)\> |

## Properties

### dlsr

• **dlsr**: `number`

delay since last SR

___

### fractionLost

• **fractionLost**: `number`

___

### highestSequence

• **highestSequence**: `number`

___

### jitter

• **jitter**: `number`

___

### lsr

• **lsr**: `number`

last SR

___

### packetsLost

• **packetsLost**: `number`

___

### ssrc

• **ssrc**: `number`

## Methods

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

___

### deSerialize

▸ `Static` **deSerialize**(`data`): [`RtcpReceiverInfo`](RtcpReceiverInfo.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |

#### Returns

[`RtcpReceiverInfo`](RtcpReceiverInfo.md)

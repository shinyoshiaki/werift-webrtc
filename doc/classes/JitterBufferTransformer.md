[werift](../README.md) / [Exports](../modules.md) / JitterBufferTransformer

# Class: JitterBufferTransformer

## Table of contents

### Constructors

- [constructor](JitterBufferTransformer.md#constructor)

### Properties

- [clockRate](JitterBufferTransformer.md#clockrate)
- [options](JitterBufferTransformer.md#options)
- [presentSeqNum](JitterBufferTransformer.md#presentseqnum)
- [rtpBuffer](JitterBufferTransformer.md#rtpbuffer)
- [transform](JitterBufferTransformer.md#transform)

## Constructors

### constructor

• **new JitterBufferTransformer**(`clockRate`, `options?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `clockRate` | `number` |
| `options` | `Partial`<[`JitterBufferOptions`](../interfaces/JitterBufferOptions.md)\> |

## Properties

### clockRate

• **clockRate**: `number`

___

### options

• **options**: [`JitterBufferOptions`](../interfaces/JitterBufferOptions.md)

___

### presentSeqNum

• `Optional` **presentSeqNum**: `number`

___

### rtpBuffer

• **rtpBuffer**: `Object` = `{}`

#### Index signature

▪ [sequenceNumber: `number`]: [`RtpPacket`](RtpPacket.md)

___

### transform

• **transform**: `TransformStream`<`RtpOutput`, [`JitterBufferOutput`](../interfaces/JitterBufferOutput.md)\>

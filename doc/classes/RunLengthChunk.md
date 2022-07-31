[werift](../README.md) / [Exports](../modules.md) / RunLengthChunk

# Class: RunLengthChunk

## Table of contents

### Constructors

- [constructor](RunLengthChunk.md#constructor)

### Properties

- [packetStatus](RunLengthChunk.md#packetstatus)
- [runLength](RunLengthChunk.md#runlength)
- [type](RunLengthChunk.md#type)

### Methods

- [results](RunLengthChunk.md#results)
- [serialize](RunLengthChunk.md#serialize)
- [deSerialize](RunLengthChunk.md#deserialize)

## Constructors

### constructor

• **new RunLengthChunk**(`props?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`<[`RunLengthChunk`](RunLengthChunk.md)\> |

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:262](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/twcc.ts#L262)

## Properties

### packetStatus

• **packetStatus**: [`PacketStatus`](../enums/PacketStatus.md)

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:258](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/twcc.ts#L258)

___

### runLength

• **runLength**: `number`

13bit

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:260](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/twcc.ts#L260)

___

### type

• **type**: [`TypeTCCRunLengthChunk`](../enums/PacketChunk.md#typetccrunlengthchunk)

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:257](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/twcc.ts#L257)

## Methods

### results

▸ **results**(`currentSequenceNumber`): [`PacketResult`](PacketResult.md)[]

#### Parameters

| Name | Type |
| :------ | :------ |
| `currentSequenceNumber` | `number` |

#### Returns

[`PacketResult`](PacketResult.md)[]

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:283](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/twcc.ts#L283)

___

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:274](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/twcc.ts#L274)

___

### deSerialize

▸ `Static` **deSerialize**(`data`): [`RunLengthChunk`](RunLengthChunk.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |

#### Returns

[`RunLengthChunk`](RunLengthChunk.md)

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:267](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/twcc.ts#L267)

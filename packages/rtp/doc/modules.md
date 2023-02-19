[werift-rtp](README.md) / Exports

# werift-rtp

## Table of contents

### Enumerations

- [PacketChunk](enums/PacketChunk.md)
- [PacketStatus](enums/PacketStatus.md)

### Classes

- [AV1Obu](classes/AV1Obu.md)
- [AV1RtpPayload](classes/AV1RtpPayload.md)
- [AVBufferBase](classes/AVBufferBase.md)
- [AvBufferCallback](classes/AvBufferCallback.md)
- [BitStream](classes/BitStream.md)
- [BitWriter](classes/BitWriter.md)
- [BitWriter2](classes/BitWriter2.md)
- [BufferChain](classes/BufferChain.md)
- [DePacketizerBase](classes/DePacketizerBase.md)
- [DepacketizeBase](classes/DepacketizeBase.md)
- [DepacketizeCallback](classes/DepacketizeCallback.md)
- [GenericNack](classes/GenericNack.md)
- [H264RtpPayload](classes/H264RtpPayload.md)
- [JitterBufferBase](classes/JitterBufferBase.md)
- [JitterBufferCallback](classes/JitterBufferCallback.md)
- [JitterBufferTransformer](classes/JitterBufferTransformer.md)
- [OpusRtpPayload](classes/OpusRtpPayload.md)
- [PacketResult](classes/PacketResult.md)
- [PictureLossIndication](classes/PictureLossIndication.md)
- [PromiseQueue](classes/PromiseQueue.md)
- [ReceiverEstimatedMaxBitrate](classes/ReceiverEstimatedMaxBitrate.md)
- [RecvDelta](classes/RecvDelta.md)
- [Red](classes/Red.md)
- [RedEncoder](classes/RedEncoder.md)
- [RedHandler](classes/RedHandler.md)
- [RedHeader](classes/RedHeader.md)
- [RtcpHeader](classes/RtcpHeader.md)
- [RtcpPacketConverter](classes/RtcpPacketConverter.md)
- [RtcpPayloadSpecificFeedback](classes/RtcpPayloadSpecificFeedback.md)
- [RtcpReceiverInfo](classes/RtcpReceiverInfo.md)
- [RtcpRrPacket](classes/RtcpRrPacket.md)
- [RtcpSenderInfo](classes/RtcpSenderInfo.md)
- [RtcpSourceDescriptionPacket](classes/RtcpSourceDescriptionPacket.md)
- [RtcpSrPacket](classes/RtcpSrPacket.md)
- [RtcpTransportLayerFeedback](classes/RtcpTransportLayerFeedback.md)
- [RtpHeader](classes/RtpHeader.md)
- [RtpPacket](classes/RtpPacket.md)
- [RtpSourceCallback](classes/RtpSourceCallback.md)
- [RtpSourceStream](classes/RtpSourceStream.md)
- [RunLengthChunk](classes/RunLengthChunk.md)
- [SourceDescriptionChunk](classes/SourceDescriptionChunk.md)
- [SourceDescriptionItem](classes/SourceDescriptionItem.md)
- [SrtcpSession](classes/SrtcpSession.md)
- [SrtpSession](classes/SrtpSession.md)
- [StatusVectorChunk](classes/StatusVectorChunk.md)
- [TransportWideCC](classes/TransportWideCC.md)
- [Vp8RtpPayload](classes/Vp8RtpPayload.md)
- [Vp9RtpPayload](classes/Vp9RtpPayload.md)
- [WebmBase](classes/WebmBase.md)
- [WebmCallback](classes/WebmCallback.md)
- [WebmStream](classes/WebmStream.md)
- [WeriftError](classes/WeriftError.md)

### Interfaces

- [AvBufferOptions](interfaces/AvBufferOptions.md)
- [DepacketizerOutput](interfaces/DepacketizerOutput.md)
- [JitterBufferOptions](interfaces/JitterBufferOptions.md)
- [JitterBufferOutput](interfaces/JitterBufferOutput.md)
- [RtpOutput](interfaces/RtpOutput.md)
- [WebmOption](interfaces/WebmOption.md)

### Type Aliases

- [AVBufferInput](modules.md#avbufferinput)
- [AVBufferOutput](modules.md#avbufferoutput)
- [DepacketizerInput](modules.md#depacketizerinput)
- [Extension](modules.md#extension)
- [InterfaceAddresses](modules.md#interfaceaddresses)
- [JitterBufferInput](modules.md#jitterbufferinput)
- [RequireAtLeastOne](modules.md#requireatleastone)
- [RtcpPacket](modules.md#rtcppacket)
- [WebmInput](modules.md#webminput)
- [WebmOutput](modules.md#webmoutput)
- [WebmStreamOption](modules.md#webmstreamoption)
- [WebmStreamOutput](modules.md#webmstreamoutput)

### Variables

- [DurationPosition](modules.md#durationposition)
- [ExtensionProfiles](modules.md#extensionprofiles)
- [Max32Uint](modules.md#max32uint)
- [MaxSinged16Int](modules.md#maxsinged16int)
- [NalUnitType](modules.md#nalunittype)
- [RTCP\_HEADER\_SIZE](modules.md#rtcp_header_size)
- [SegmentSizePosition](modules.md#segmentsizeposition)

### Functions

- [buffer2ArrayBuffer](modules.md#buffer2arraybuffer)
- [bufferArrayXor](modules.md#bufferarrayxor)
- [bufferReader](modules.md#bufferreader)
- [bufferWriter](modules.md#bufferwriter)
- [bufferWriterLE](modules.md#bufferwriterle)
- [bufferXor](modules.md#bufferxor)
- [dePacketizeRtpPackets](modules.md#depacketizertppackets)
- [deepMerge](modules.md#deepmerge)
- [depacketizeTransformer](modules.md#depacketizetransformer)
- [dumpBuffer](modules.md#dumpbuffer)
- [findPort](modules.md#findport)
- [getBit](modules.md#getbit)
- [int](modules.md#int)
- [interfaceAddress](modules.md#interfaceaddress)
- [jitterBufferTransformer](modules.md#jitterbuffertransformer)
- [leb128decode](modules.md#leb128decode)
- [paddingBits](modules.md#paddingbits)
- [paddingByte](modules.md#paddingbyte)
- [random16](modules.md#random16)
- [random32](modules.md#random32)
- [randomPort](modules.md#randomport)
- [randomPorts](modules.md#randomports)
- [replaceSegmentSize](modules.md#replacesegmentsize)
- [uint16Add](modules.md#uint16add)
- [uint16Gt](modules.md#uint16gt)
- [uint16Gte](modules.md#uint16gte)
- [uint24](modules.md#uint24)
- [uint32Add](modules.md#uint32add)
- [uint32Gt](modules.md#uint32gt)
- [uint32Gte](modules.md#uint32gte)
- [uint8Add](modules.md#uint8add)

## Type Aliases

### AVBufferInput

Ƭ **AVBufferInput**: [`DepacketizerOutput`](interfaces/DepacketizerOutput.md)

___

### AVBufferOutput

Ƭ **AVBufferOutput**: [`AVBufferInput`](modules.md#avbufferinput)

___

### DepacketizerInput

Ƭ **DepacketizerInput**: [`RtpOutput`](interfaces/RtpOutput.md)

___

### Extension

Ƭ **Extension**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `id` | `number` |
| `payload` | `Buffer` |

___

### InterfaceAddresses

Ƭ **InterfaceAddresses**: { [K in SocketType]?: string }

___

### JitterBufferInput

Ƭ **JitterBufferInput**: [`RtpOutput`](interfaces/RtpOutput.md)

___

### RequireAtLeastOne

Ƭ **RequireAtLeastOne**<`T`\>: { [K in keyof T]-?: Required<Pick<T, K\>\> & Partial<Pick<T, Exclude<keyof T, K\>\>\> }[keyof `T`]

#### Type parameters

| Name |
| :------ |
| `T` |

___

### RtcpPacket

Ƭ **RtcpPacket**: [`RtcpRrPacket`](classes/RtcpRrPacket.md) \| [`RtcpSrPacket`](classes/RtcpSrPacket.md) \| [`RtcpPayloadSpecificFeedback`](classes/RtcpPayloadSpecificFeedback.md) \| [`RtcpSourceDescriptionPacket`](classes/RtcpSourceDescriptionPacket.md) \| [`RtcpTransportLayerFeedback`](classes/RtcpTransportLayerFeedback.md)

___

### WebmInput

Ƭ **WebmInput**: [`DepacketizerOutput`](interfaces/DepacketizerOutput.md)

___

### WebmOutput

Ƭ **WebmOutput**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `eol?` | { `duration`: `number` ; `durationElement`: `Uint8Array`  } |
| `eol.duration` | `number` |
| `eol.durationElement` | `Uint8Array` |
| `kind?` | ``"initial"`` \| ``"cluster"`` \| ``"block"`` \| ``"cuePoints"`` |
| `previousDuration?` | `number` |
| `saveToFile?` | `Buffer` |

___

### WebmStreamOption

Ƭ **WebmStreamOption**: [`WebmOption`](interfaces/WebmOption.md)

___

### WebmStreamOutput

Ƭ **WebmStreamOutput**: [`WebmOutput`](modules.md#webmoutput)

## Variables

### DurationPosition

• `Const` **DurationPosition**: ``83``

___

### ExtensionProfiles

• `Const` **ExtensionProfiles**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `OneByte` | ``48862`` |
| `TwoByte` | ``4096`` |

___

### Max32Uint

• `Const` **Max32Uint**: `number`

4294967295

___

### MaxSinged16Int

• `Const` **MaxSinged16Int**: `number`

32767

___

### NalUnitType

• `Const` **NalUnitType**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `fu_a` | ``28`` |
| `fu_b` | ``29`` |
| `idrSlice` | ``5`` |
| `mtap16` | ``26`` |
| `mtap24` | ``27`` |
| `stap_a` | ``24`` |
| `stap_b` | ``25`` |

___

### RTCP\_HEADER\_SIZE

• `Const` **RTCP\_HEADER\_SIZE**: ``4``

___

### SegmentSizePosition

• `Const` **SegmentSizePosition**: ``40``

## Functions

### buffer2ArrayBuffer

▸ **buffer2ArrayBuffer**(`buf`): `ArrayBuffer`

#### Parameters

| Name | Type |
| :------ | :------ |
| `buf` | `Buffer` |

#### Returns

`ArrayBuffer`

___

### bufferArrayXor

▸ **bufferArrayXor**(`arr`): `Buffer`

#### Parameters

| Name | Type |
| :------ | :------ |
| `arr` | `Buffer`[] |

#### Returns

`Buffer`

___

### bufferReader

▸ **bufferReader**(`buf`, `bytes`): `any`[]

#### Parameters

| Name | Type |
| :------ | :------ |
| `buf` | `Buffer` |
| `bytes` | `number`[] |

#### Returns

`any`[]

___

### bufferWriter

▸ **bufferWriter**(`bytes`, `values`): `Buffer`

#### Parameters

| Name | Type |
| :------ | :------ |
| `bytes` | `number`[] |
| `values` | (`number` \| `bigint`)[] |

#### Returns

`Buffer`

___

### bufferWriterLE

▸ **bufferWriterLE**(`bytes`, `values`): `Buffer`

#### Parameters

| Name | Type |
| :------ | :------ |
| `bytes` | `number`[] |
| `values` | (`number` \| `bigint`)[] |

#### Returns

`Buffer`

___

### bufferXor

▸ **bufferXor**(`a`, `b`): `Buffer`

#### Parameters

| Name | Type |
| :------ | :------ |
| `a` | `Buffer` |
| `b` | `Buffer` |

#### Returns

`Buffer`

___

### dePacketizeRtpPackets

▸ **dePacketizeRtpPackets**(`codec`, `packets`): `Object`

#### Parameters

| Name | Type |
| :------ | :------ |
| `codec` | `string` |
| `packets` | [`RtpPacket`](classes/RtpPacket.md)[] |

#### Returns

`Object`

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |
| `isKeyframe` | `boolean` |

___

### deepMerge

▸ **deepMerge**<`T`\>(`dst`, `src`): `T`

#### Type parameters

| Name |
| :------ |
| `T` |

#### Parameters

| Name | Type |
| :------ | :------ |
| `dst` | `T` |
| `src` | `T` |

#### Returns

`T`

___

### depacketizeTransformer

▸ **depacketizeTransformer**(`...args`): `TransformStream`<[`RtpOutput`](interfaces/RtpOutput.md), [`DepacketizerOutput`](interfaces/DepacketizerOutput.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `...args` | [codec: string, options: Object] |

#### Returns

`TransformStream`<[`RtpOutput`](interfaces/RtpOutput.md), [`DepacketizerOutput`](interfaces/DepacketizerOutput.md)\>

___

### dumpBuffer

▸ **dumpBuffer**(`data`): `string`

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |

#### Returns

`string`

___

### findPort

▸ **findPort**(`min`, `max`, `protocol?`, `interfaceAddresses?`): `Promise`<`number`\>

#### Parameters

| Name | Type | Default value |
| :------ | :------ | :------ |
| `min` | `number` | `undefined` |
| `max` | `number` | `undefined` |
| `protocol` | `SocketType` | `"udp4"` |
| `interfaceAddresses?` | [`InterfaceAddresses`](modules.md#interfaceaddresses) | `undefined` |

#### Returns

`Promise`<`number`\>

___

### getBit

▸ **getBit**(`bits`, `startIndex`, `length?`): `number`

#### Parameters

| Name | Type | Default value |
| :------ | :------ | :------ |
| `bits` | `number` | `undefined` |
| `startIndex` | `number` | `undefined` |
| `length` | `number` | `1` |

#### Returns

`number`

___

### int

▸ **int**(`n`): `number`

#### Parameters

| Name | Type |
| :------ | :------ |
| `n` | `number` |

#### Returns

`number`

___

### interfaceAddress

▸ **interfaceAddress**(`type`, `interfaceAddresses`): `undefined` \| `string`

#### Parameters

| Name | Type |
| :------ | :------ |
| `type` | `SocketType` |
| `interfaceAddresses` | `undefined` \| [`InterfaceAddresses`](modules.md#interfaceaddresses) |

#### Returns

`undefined` \| `string`

___

### jitterBufferTransformer

▸ **jitterBufferTransformer**(`...args`): `TransformStream`<[`RtpOutput`](interfaces/RtpOutput.md), [`JitterBufferOutput`](interfaces/JitterBufferOutput.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `...args` | [clockRate: number, options: Partial<JitterBufferOptions\>] |

#### Returns

`TransformStream`<[`RtpOutput`](interfaces/RtpOutput.md), [`JitterBufferOutput`](interfaces/JitterBufferOutput.md)\>

___

### leb128decode

▸ **leb128decode**(`buf`): `number`[]

#### Parameters

| Name | Type |
| :------ | :------ |
| `buf` | `Buffer` |

#### Returns

`number`[]

___

### paddingBits

▸ **paddingBits**(`bits`, `expectLength`): `string`

#### Parameters

| Name | Type |
| :------ | :------ |
| `bits` | `number` |
| `expectLength` | `number` |

#### Returns

`string`

___

### paddingByte

▸ **paddingByte**(`bits`): `string`

#### Parameters

| Name | Type |
| :------ | :------ |
| `bits` | `number` |

#### Returns

`string`

___

### random16

▸ **random16**(): `any`

#### Returns

`any`

___

### random32

▸ **random32**(): `any`

#### Returns

`any`

___

### randomPort

▸ **randomPort**(`protocol?`, `interfaceAddresses?`): `Promise`<`number`\>

#### Parameters

| Name | Type | Default value |
| :------ | :------ | :------ |
| `protocol` | `SocketType` | `"udp4"` |
| `interfaceAddresses?` | [`InterfaceAddresses`](modules.md#interfaceaddresses) | `undefined` |

#### Returns

`Promise`<`number`\>

___

### randomPorts

▸ **randomPorts**(`num`, `protocol?`, `interfaceAddresses?`): `Promise`<`number`[]\>

#### Parameters

| Name | Type | Default value |
| :------ | :------ | :------ |
| `num` | `number` | `undefined` |
| `protocol` | `SocketType` | `"udp4"` |
| `interfaceAddresses?` | [`InterfaceAddresses`](modules.md#interfaceaddresses) | `undefined` |

#### Returns

`Promise`<`number`[]\>

___

### replaceSegmentSize

▸ **replaceSegmentSize**(`totalFileSize`): `Buffer`

#### Parameters

| Name | Type |
| :------ | :------ |
| `totalFileSize` | `number` |

#### Returns

`Buffer`

___

### uint16Add

▸ **uint16Add**(`a`, `b`): `number`

#### Parameters

| Name | Type |
| :------ | :------ |
| `a` | `number` |
| `b` | `number` |

#### Returns

`number`

___

### uint16Gt

▸ **uint16Gt**(`a`, `b`): `boolean`

Return a > b

#### Parameters

| Name | Type |
| :------ | :------ |
| `a` | `number` |
| `b` | `number` |

#### Returns

`boolean`

___

### uint16Gte

▸ **uint16Gte**(`a`, `b`): `boolean`

Return a >= b

#### Parameters

| Name | Type |
| :------ | :------ |
| `a` | `number` |
| `b` | `number` |

#### Returns

`boolean`

___

### uint24

▸ **uint24**(`v`): `number`

#### Parameters

| Name | Type |
| :------ | :------ |
| `v` | `number` |

#### Returns

`number`

___

### uint32Add

▸ **uint32Add**(`a`, `b`): `number`

#### Parameters

| Name | Type |
| :------ | :------ |
| `a` | `number` |
| `b` | `number` |

#### Returns

`number`

___

### uint32Gt

▸ **uint32Gt**(`a`, `b`): `boolean`

Return a > b

#### Parameters

| Name | Type |
| :------ | :------ |
| `a` | `number` |
| `b` | `number` |

#### Returns

`boolean`

___

### uint32Gte

▸ **uint32Gte**(`a`, `b`): `boolean`

Return a >= b

#### Parameters

| Name | Type |
| :------ | :------ |
| `a` | `number` |
| `b` | `number` |

#### Returns

`boolean`

___

### uint8Add

▸ **uint8Add**(`a`, `b`): `number`

#### Parameters

| Name | Type |
| :------ | :------ |
| `a` | `number` |
| `b` | `number` |

#### Returns

`number`

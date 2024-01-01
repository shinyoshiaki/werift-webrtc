[werift-rtp](README.md) / Exports

# werift-rtp

## Table of contents

### Enumerations

- [PacketChunk](enums/PacketChunk.md)
- [PacketStatus](enums/PacketStatus.md)

### Classes

- [AV1Obu](classes/AV1Obu.md)
- [AV1RtpPayload](classes/AV1RtpPayload.md)
- [BitStream](classes/BitStream.md)
- [BitWriter](classes/BitWriter.md)
- [BitWriter2](classes/BitWriter2.md)
- [BufferChain](classes/BufferChain.md)
- [DePacketizerBase](classes/DePacketizerBase.md)
- [GenericNack](classes/GenericNack.md)
- [H264RtpPayload](classes/H264RtpPayload.md)
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
- [RtpBuilder](classes/RtpBuilder.md)
- [RtpHeader](classes/RtpHeader.md)
- [RtpPacket](classes/RtpPacket.md)
- [RunLengthChunk](classes/RunLengthChunk.md)
- [SourceDescriptionChunk](classes/SourceDescriptionChunk.md)
- [SourceDescriptionItem](classes/SourceDescriptionItem.md)
- [SrtcpSession](classes/SrtcpSession.md)
- [SrtpSession](classes/SrtpSession.md)
- [StatusVectorChunk](classes/StatusVectorChunk.md)
- [TransportWideCC](classes/TransportWideCC.md)
- [Vp8RtpPayload](classes/Vp8RtpPayload.md)
- [Vp9RtpPayload](classes/Vp9RtpPayload.md)
- [WeriftError](classes/WeriftError.md)

### Type Aliases

- [AudioLevelIndicationPayload](modules.md#audiolevelindicationpayload)
- [DepacketizerCodec](modules.md#depacketizercodec)
- [Extension](modules.md#extension)
- [InterfaceAddresses](modules.md#interfaceaddresses)
- [RequireAtLeastOne](modules.md#requireatleastone)
- [RtcpPacket](modules.md#rtcppacket)
- [TransportWideCCPayload](modules.md#transportwideccpayload)

### Variables

- [ExtensionProfiles](modules.md#extensionprofiles)
- [NalUnitType](modules.md#nalunittype)
- [RTCP\_HEADER\_SIZE](modules.md#rtcp_header_size)
- [RTP\_EXTENSION\_URI](modules.md#rtp_extension_uri)
- [depacketizerCodecs](modules.md#depacketizercodecs)
- [timer](modules.md#timer)

### Functions

- [Int](modules.md#int)
- [buffer2ArrayBuffer](modules.md#buffer2arraybuffer)
- [bufferArrayXor](modules.md#bufferarrayxor)
- [bufferReader](modules.md#bufferreader)
- [bufferWriter](modules.md#bufferwriter)
- [bufferWriterLE](modules.md#bufferwriterle)
- [bufferXor](modules.md#bufferxor)
- [createBufferWriter](modules.md#createbufferwriter)
- [dePacketizeRtpPackets](modules.md#depacketizertppackets)
- [deserializeAbsSendTime](modules.md#deserializeabssendtime)
- [deserializeAudioLevelIndication](modules.md#deserializeaudiolevelindication)
- [deserializeString](modules.md#deserializestring)
- [deserializeUint16BE](modules.md#deserializeuint16be)
- [dumpBuffer](modules.md#dumpbuffer)
- [enumerate](modules.md#enumerate)
- [findPort](modules.md#findport)
- [getBit](modules.md#getbit)
- [growBufferSize](modules.md#growbuffersize)
- [int](modules.md#int-1)
- [interfaceAddress](modules.md#interfaceaddress)
- [isMedia](modules.md#ismedia)
- [isRtcp](modules.md#isrtcp)
- [leb128decode](modules.md#leb128decode)
- [ntpTime2Sec](modules.md#ntptime2sec)
- [paddingBits](modules.md#paddingbits)
- [paddingByte](modules.md#paddingbyte)
- [random16](modules.md#random16)
- [random32](modules.md#random32)
- [randomPort](modules.md#randomport)
- [randomPorts](modules.md#randomports)
- [rtpHeaderExtensionsParser](modules.md#rtpheaderextensionsparser)
- [serializeAbsSendTime](modules.md#serializeabssendtime)
- [serializeAudioLevelIndication](modules.md#serializeaudiolevelindication)
- [serializeRepairedRtpStreamId](modules.md#serializerepairedrtpstreamid)
- [serializeSdesMid](modules.md#serializesdesmid)
- [serializeSdesRTPStreamID](modules.md#serializesdesrtpstreamid)
- [serializeTransportWideCC](modules.md#serializetransportwidecc)
- [uint16Add](modules.md#uint16add)
- [uint16Gt](modules.md#uint16gt)
- [uint16Gte](modules.md#uint16gte)
- [uint24](modules.md#uint24)
- [uint32Add](modules.md#uint32add)
- [uint32Gt](modules.md#uint32gt)
- [uint32Gte](modules.md#uint32gte)
- [uint8Add](modules.md#uint8add)
- [unwrapRtx](modules.md#unwraprtx)
- [wrapRtx](modules.md#wraprtx)

## Type Aliases

### AudioLevelIndicationPayload

Ƭ **AudioLevelIndicationPayload**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `level` | `number` |
| `v` | `boolean` |

___

### DepacketizerCodec

Ƭ **DepacketizerCodec**: typeof [`depacketizerCodecs`](modules.md#depacketizercodecs)[`number`] \| `Lowercase`\<typeof [`depacketizerCodecs`](modules.md#depacketizercodecs)[`number`]\>

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

Ƭ **InterfaceAddresses**: \{ [K in SocketType]?: string }

___

### RequireAtLeastOne

Ƭ **RequireAtLeastOne**\<`T`\>: \{ [K in keyof T]-?: Required\<Pick\<T, K\>\> & Partial\<Pick\<T, Exclude\<keyof T, K\>\>\> }[keyof `T`]

#### Type parameters

| Name |
| :------ |
| `T` |

___

### RtcpPacket

Ƭ **RtcpPacket**: [`RtcpRrPacket`](classes/RtcpRrPacket.md) \| [`RtcpSrPacket`](classes/RtcpSrPacket.md) \| [`RtcpPayloadSpecificFeedback`](classes/RtcpPayloadSpecificFeedback.md) \| [`RtcpSourceDescriptionPacket`](classes/RtcpSourceDescriptionPacket.md) \| [`RtcpTransportLayerFeedback`](classes/RtcpTransportLayerFeedback.md)

___

### TransportWideCCPayload

Ƭ **TransportWideCCPayload**: `number`

## Variables

### ExtensionProfiles

• `Const` **ExtensionProfiles**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `OneByte` | ``48862`` |
| `TwoByte` | ``4096`` |

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

### RTP\_EXTENSION\_URI

• `Const` **RTP\_EXTENSION\_URI**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `absSendTime` | ``"http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time"`` |
| `audioLevelIndication` | ``"urn:ietf:params:rtp-hdrext:ssrc-audio-level"`` |
| `dependencyDescriptor` | ``"https://aomediacodec.github.io/av1-rtp-spec/#dependency-descriptor-rtp-header-extension"`` |
| `repairedRtpStreamId` | ``"urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id"`` |
| `sdesMid` | ``"urn:ietf:params:rtp-hdrext:sdes:mid"`` |
| `sdesRTPStreamID` | ``"urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id"`` |
| `transportWideCC` | ``"http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01"`` |

___

### depacketizerCodecs

• `Const` **depacketizerCodecs**: readonly [``"MPEG4/ISO/AVC"``, ``"VP8"``, ``"VP9"``, ``"OPUS"``, ``"AV1"``]

___

### timer

• `Const` **timer**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `setInterval` | (...`args`: [callback: Function, ms?: number]) => () => `void` |
| `setTimeout` | (...`args`: [callback: Function, ms?: number]) => () => `void` |

## Functions

### Int

▸ **Int**(`v`): `number`

#### Parameters

| Name | Type |
| :------ | :------ |
| `v` | `number` |

#### Returns

`number`

___

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

### createBufferWriter

▸ **createBufferWriter**(`bytes`, `singleBuffer?`): (`values`: (`number` \| `bigint`)[]) => `Buffer`

#### Parameters

| Name | Type |
| :------ | :------ |
| `bytes` | `number`[] |
| `singleBuffer?` | `boolean` |

#### Returns

`fn`

▸ (`values`): `Buffer`

##### Parameters

| Name | Type |
| :------ | :------ |
| `values` | (`number` \| `bigint`)[] |

##### Returns

`Buffer`

___

### dePacketizeRtpPackets

▸ **dePacketizeRtpPackets**(`codec`, `packets`, `frameFragmentBuffer?`): `Object`

#### Parameters

| Name | Type |
| :------ | :------ |
| `codec` | [`DepacketizerCodec`](modules.md#depacketizercodec) |
| `packets` | [`RtpPacket`](classes/RtpPacket.md)[] |
| `frameFragmentBuffer?` | `Buffer` |

#### Returns

`Object`

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |
| `frameFragmentBuffer?` | `Buffer` |
| `isKeyframe` | `boolean` |
| `sequence` | `number` |
| `timestamp` | `number` |

___

### deserializeAbsSendTime

▸ **deserializeAbsSendTime**(`buf`): `any`

#### Parameters

| Name | Type |
| :------ | :------ |
| `buf` | `Buffer` |

#### Returns

`any`

___

### deserializeAudioLevelIndication

▸ **deserializeAudioLevelIndication**(`buf`): [`AudioLevelIndicationPayload`](modules.md#audiolevelindicationpayload)

#### Parameters

| Name | Type |
| :------ | :------ |
| `buf` | `Buffer` |

#### Returns

[`AudioLevelIndicationPayload`](modules.md#audiolevelindicationpayload)

___

### deserializeString

▸ **deserializeString**(`buf`): `string`

#### Parameters

| Name | Type |
| :------ | :------ |
| `buf` | `Buffer` |

#### Returns

`string`

___

### deserializeUint16BE

▸ **deserializeUint16BE**(`buf`): `number`

#### Parameters

| Name | Type |
| :------ | :------ |
| `buf` | `Buffer` |

#### Returns

`number`

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

### enumerate

▸ **enumerate**\<`T`\>(`arr`): [`number`, `T`][]

#### Type parameters

| Name |
| :------ |
| `T` |

#### Parameters

| Name | Type |
| :------ | :------ |
| `arr` | `T`[] |

#### Returns

[`number`, `T`][]

___

### findPort

▸ **findPort**(`min`, `max`, `protocol?`, `interfaceAddresses?`): `Promise`\<`number`\>

#### Parameters

| Name | Type | Default value |
| :------ | :------ | :------ |
| `min` | `number` | `undefined` |
| `max` | `number` | `undefined` |
| `protocol` | `SocketType` | `"udp4"` |
| `interfaceAddresses?` | [`InterfaceAddresses`](modules.md#interfaceaddresses) | `undefined` |

#### Returns

`Promise`\<`number`\>

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

### growBufferSize

▸ **growBufferSize**(`buf`, `size`): `Buffer`

#### Parameters

| Name | Type |
| :------ | :------ |
| `buf` | `Buffer` |
| `size` | `number` |

#### Returns

`Buffer`

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

### isMedia

▸ **isMedia**(`buf`): `boolean`

#### Parameters

| Name | Type |
| :------ | :------ |
| `buf` | `Buffer` |

#### Returns

`boolean`

___

### isRtcp

▸ **isRtcp**(`buf`): `boolean`

#### Parameters

| Name | Type |
| :------ | :------ |
| `buf` | `Buffer` |

#### Returns

`boolean`

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

### ntpTime2Sec

▸ **ntpTime2Sec**(`ntp`): `number`

#### Parameters

| Name | Type |
| :------ | :------ |
| `ntp` | `bigint` |

#### Returns

`number`

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

▸ **randomPort**(`protocol?`, `interfaceAddresses?`): `Promise`\<`number`\>

#### Parameters

| Name | Type | Default value |
| :------ | :------ | :------ |
| `protocol` | `SocketType` | `"udp4"` |
| `interfaceAddresses?` | [`InterfaceAddresses`](modules.md#interfaceaddresses) | `undefined` |

#### Returns

`Promise`\<`number`\>

___

### randomPorts

▸ **randomPorts**(`num`, `protocol?`, `interfaceAddresses?`): `Promise`\<`number`[]\>

#### Parameters

| Name | Type | Default value |
| :------ | :------ | :------ |
| `num` | `number` | `undefined` |
| `protocol` | `SocketType` | `"udp4"` |
| `interfaceAddresses?` | [`InterfaceAddresses`](modules.md#interfaceaddresses) | `undefined` |

#### Returns

`Promise`\<`number`[]\>

___

### rtpHeaderExtensionsParser

▸ **rtpHeaderExtensionsParser**(`extensions`, `extIdUriMap`): `Object`

#### Parameters

| Name | Type |
| :------ | :------ |
| `extensions` | [`Extension`](modules.md#extension)[] |
| `extIdUriMap` | `Object` |

#### Returns

`Object`

___

### serializeAbsSendTime

▸ **serializeAbsSendTime**(`ntpTime`): `Buffer`

#### Parameters

| Name | Type |
| :------ | :------ |
| `ntpTime` | `bigint` |

#### Returns

`Buffer`

___

### serializeAudioLevelIndication

▸ **serializeAudioLevelIndication**(`level`): `Buffer`

#### Parameters

| Name | Type |
| :------ | :------ |
| `level` | `number` |

#### Returns

`Buffer`

___

### serializeRepairedRtpStreamId

▸ **serializeRepairedRtpStreamId**(`id`): `Buffer`

#### Parameters

| Name | Type |
| :------ | :------ |
| `id` | `string` |

#### Returns

`Buffer`

___

### serializeSdesMid

▸ **serializeSdesMid**(`id`): `Buffer`

#### Parameters

| Name | Type |
| :------ | :------ |
| `id` | `string` |

#### Returns

`Buffer`

___

### serializeSdesRTPStreamID

▸ **serializeSdesRTPStreamID**(`id`): `Buffer`

#### Parameters

| Name | Type |
| :------ | :------ |
| `id` | `string` |

#### Returns

`Buffer`

___

### serializeTransportWideCC

▸ **serializeTransportWideCC**(`transportSequenceNumber`): `Buffer`

#### Parameters

| Name | Type |
| :------ | :------ |
| `transportSequenceNumber` | `number` |

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

___

### unwrapRtx

▸ **unwrapRtx**(`rtx`, `payloadType`, `ssrc`): [`RtpPacket`](classes/RtpPacket.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `rtx` | [`RtpPacket`](classes/RtpPacket.md) |
| `payloadType` | `number` |
| `ssrc` | `number` |

#### Returns

[`RtpPacket`](classes/RtpPacket.md)

___

### wrapRtx

▸ **wrapRtx**(`packet`, `payloadType`, `sequenceNumber`, `ssrc`): [`RtpPacket`](classes/RtpPacket.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `packet` | [`RtpPacket`](classes/RtpPacket.md) |
| `payloadType` | `number` |
| `sequenceNumber` | `number` |
| `ssrc` | `number` |

#### Returns

[`RtpPacket`](classes/RtpPacket.md)

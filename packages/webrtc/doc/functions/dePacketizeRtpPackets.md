[**werift**](../README.md)

***

[werift](../globals.md) / dePacketizeRtpPackets

# Function: dePacketizeRtpPackets()

> **dePacketizeRtpPackets**(`codec`, `packets`, `frameFragmentBuffer`?): `object`

## Parameters

### codec

[`DepacketizerCodec`](../type-aliases/DepacketizerCodec.md)

### packets

[`RtpPacket`](../classes/RtpPacket.md)[]

### frameFragmentBuffer?

`Buffer`\<`ArrayBufferLike`\>

## Returns

`object`

### data

> **data**: `Buffer`

### frameFragmentBuffer?

> `optional` **frameFragmentBuffer**: `Buffer`\<`ArrayBufferLike`\>

### isKeyframe

> **isKeyframe**: `boolean`

### sequence

> **sequence**: `number`

### timestamp

> **timestamp**: `number`

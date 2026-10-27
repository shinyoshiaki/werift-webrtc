[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / RtcpSourceDescriptionPacket

# Class: RtcpSourceDescriptionPacket

## Constructors

### new RtcpSourceDescriptionPacket()

> **new RtcpSourceDescriptionPacket**(`props`): [`RtcpSourceDescriptionPacket`](RtcpSourceDescriptionPacket.md)

#### Parameters

##### props

`Partial`\<[`RtcpSourceDescriptionPacket`](RtcpSourceDescriptionPacket.md)\>

#### Returns

[`RtcpSourceDescriptionPacket`](RtcpSourceDescriptionPacket.md)

## Properties

### chunks

> **chunks**: [`SourceDescriptionChunk`](SourceDescriptionChunk.md)[] = `[]`

***

### type

> `readonly` **type**: `202` = `RtcpSourceDescriptionPacket.type`

***

### type

> `readonly` `static` **type**: `202` = `202`

## Accessors

### length

#### Get Signature

> **get** **length**(): `number`

##### Returns

`number`

## Methods

### serialize()

> **serialize**(): `Buffer`\<`ArrayBuffer`\>

#### Returns

`Buffer`\<`ArrayBuffer`\>

***

### deSerialize()

> `static` **deSerialize**(`payload`, `header`): [`RtcpSourceDescriptionPacket`](RtcpSourceDescriptionPacket.md)

#### Parameters

##### payload

`Buffer`

##### header

[`RtcpHeader`](RtcpHeader.md)

#### Returns

[`RtcpSourceDescriptionPacket`](RtcpSourceDescriptionPacket.md)

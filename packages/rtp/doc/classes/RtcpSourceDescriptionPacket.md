[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / RtcpSourceDescriptionPacket

# Class: RtcpSourceDescriptionPacket

## Constructors

### Constructor

> **new RtcpSourceDescriptionPacket**(`props`): `RtcpSourceDescriptionPacket`

#### Parameters

##### props

`Partial`\<`RtcpSourceDescriptionPacket`\>

#### Returns

`RtcpSourceDescriptionPacket`

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

> `static` **deSerialize**(`payload`, `header`): `RtcpSourceDescriptionPacket`

#### Parameters

##### payload

`Buffer`

##### header

[`RtcpHeader`](RtcpHeader.md)

#### Returns

`RtcpSourceDescriptionPacket`

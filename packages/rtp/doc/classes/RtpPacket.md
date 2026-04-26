[**werift-rtp**](../README.md) • **Docs**

***

[werift-rtp](../globals.md) / RtpPacket

# Class: RtpPacket

## Constructors

### new RtpPacket()

> **new RtpPacket**(`header`, `payload`): [`RtpPacket`](RtpPacket.md)

#### Parameters

• **header**: [`RtpHeader`](RtpHeader.md)

• **payload**: `Buffer`

#### Returns

[`RtpPacket`](RtpPacket.md)

## Properties

### header

> **header**: [`RtpHeader`](RtpHeader.md)

***

### payload

> **payload**: `Buffer`

## Accessors

### serializeSize

> `get` **serializeSize**(): `number`

#### Returns

`number`

## Methods

### clear()

> **clear**(): `void`

#### Returns

`void`

***

### clone()

> **clone**(): [`RtpPacket`](RtpPacket.md)

#### Returns

[`RtpPacket`](RtpPacket.md)

***

### serialize()

> **serialize**(): `Buffer`

#### Returns

`Buffer`

***

### deSerialize()

> `static` **deSerialize**(`buf`): [`RtpPacket`](RtpPacket.md)

#### Parameters

• **buf**: `Buffer`

#### Returns

[`RtpPacket`](RtpPacket.md)

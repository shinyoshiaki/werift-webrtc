[**werift**](../README.md)

***

[werift](../globals.md) / RtpPacket

# Class: RtpPacket

## Constructors

### Constructor

> **new RtpPacket**(`header`, `payload`): `RtpPacket`

#### Parameters

##### header

[`RtpHeader`](RtpHeader.md)

##### payload

`Buffer`

#### Returns

`RtpPacket`

## Properties

### header

> **header**: [`RtpHeader`](RtpHeader.md)

***

### payload

> **payload**: `Buffer`

## Accessors

### serializeSize

#### Get Signature

> **get** **serializeSize**(): `number`

##### Returns

`number`

## Methods

### clear()

> **clear**(): `void`

#### Returns

`void`

***

### clone()

> **clone**(): `RtpPacket`

#### Returns

`RtpPacket`

***

### serialize()

> **serialize**(): `Buffer`\<`ArrayBuffer`\>

#### Returns

`Buffer`\<`ArrayBuffer`\>

***

### deSerialize()

> `static` **deSerialize**(`buf`): `RtpPacket`

#### Parameters

##### buf

`Buffer`

#### Returns

`RtpPacket`

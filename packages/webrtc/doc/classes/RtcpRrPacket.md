[**werift**](../README.md)

***

[werift](../globals.md) / RtcpRrPacket

# Class: RtcpRrPacket

## Constructors

### Constructor

> **new RtcpRrPacket**(`props?`): `RtcpRrPacket`

#### Parameters

##### props?

`Partial`\<`RtcpRrPacket`\> = `{}`

#### Returns

`RtcpRrPacket`

## Properties

### reports

> **reports**: [`RtcpReceiverInfo`](RtcpReceiverInfo.md)[] = `[]`

***

### ssrc

> **ssrc**: `number` = `0`

***

### type

> `readonly` **type**: `201` = `RtcpRrPacket.type`

***

### type

> `readonly` `static` **type**: `201` = `201`

## Methods

### serialize()

> **serialize**(): `Buffer`\<`ArrayBuffer`\>

#### Returns

`Buffer`\<`ArrayBuffer`\>

***

### deSerialize()

> `static` **deSerialize**(`data`, `count`): `RtcpRrPacket`

#### Parameters

##### data

`Buffer`

##### count

`number`

#### Returns

`RtcpRrPacket`

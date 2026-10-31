[**werift**](../README.md)

***

[werift](../globals.md) / RecvDelta

# Class: RecvDelta

## Constructors

### Constructor

> **new RecvDelta**(`props?`): `RecvDelta`

#### Parameters

##### props?

`Partial`\<`RecvDelta`\> = `{}`

#### Returns

`RecvDelta`

## Properties

### delta

> **delta**: `number`

micro sec

***

### parsed

> **parsed**: `boolean` = `false`

***

### type?

> `optional` **type?**: [`TypeTCCPacketReceivedSmallDelta`](../enumerations/PacketStatus.md#typetccpacketreceivedsmalldelta) \| [`TypeTCCPacketReceivedLargeDelta`](../enumerations/PacketStatus.md#typetccpacketreceivedlargedelta)

optional (If undefined, it will be set automatically.)

## Methods

### deSerialize()

> **deSerialize**(`data`): `void`

#### Parameters

##### data

`Buffer`

#### Returns

`void`

***

### parseDelta()

> **parseDelta**(): `void`

#### Returns

`void`

***

### serialize()

> **serialize**(): `Buffer`\<`ArrayBuffer`\>

#### Returns

`Buffer`\<`ArrayBuffer`\>

***

### deSerialize()

> `static` **deSerialize**(`data`): `RecvDelta`

#### Parameters

##### data

`Buffer`

#### Returns

`RecvDelta`

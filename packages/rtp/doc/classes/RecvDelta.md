[**werift-rtp**](../README.md) • **Docs**

***

[werift-rtp](../globals.md) / RecvDelta

# Class: RecvDelta

## Constructors

### new RecvDelta()

> **new RecvDelta**(`props`): [`RecvDelta`](RecvDelta.md)

#### Parameters

• **props**: `Partial`\<[`RecvDelta`](RecvDelta.md)\> = `{}`

#### Returns

[`RecvDelta`](RecvDelta.md)

## Properties

### delta

> **delta**: `number`

micro sec

***

### parsed

> **parsed**: `boolean` = `false`

***

### type?

> `optional` **type**: [`TypeTCCPacketReceivedSmallDelta`](../enumerations/PacketStatus.md#typetccpacketreceivedsmalldelta) \| [`TypeTCCPacketReceivedLargeDelta`](../enumerations/PacketStatus.md#typetccpacketreceivedlargedelta)

optional (If undefined, it will be set automatically.)

## Methods

### deSerialize()

> **deSerialize**(`data`): `void`

#### Parameters

• **data**: `Buffer`

#### Returns

`void`

***

### parseDelta()

> **parseDelta**(): `void`

#### Returns

`void`

***

### serialize()

> **serialize**(): `Buffer`

#### Returns

`Buffer`

***

### deSerialize()

> `static` **deSerialize**(`data`): [`RecvDelta`](RecvDelta.md)

#### Parameters

• **data**: `Buffer`

#### Returns

[`RecvDelta`](RecvDelta.md)

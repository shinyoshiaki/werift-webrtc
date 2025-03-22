[**werift**](../README.md) • **Docs**

***

[werift](../globals.md) / RtpHeader

# Class: RtpHeader

## Constructors

### new RtpHeader()

> **new RtpHeader**(`props`): [`RtpHeader`](RtpHeader.md)

#### Parameters

• **props**: `Partial`\<[`RtpHeader`](RtpHeader.md)\> = `{}`

#### Returns

[`RtpHeader`](RtpHeader.md)

## Properties

### csrc

> **csrc**: `number`[] = `[]`

***

### csrcLength

> **csrcLength**: `number` = `0`

***

### extension

> **extension**: `boolean` = `false`

***

### extensionLength?

> `optional` **extensionLength**: `number`

deserialize only

***

### extensionProfile

> **extensionProfile**: `ExtensionProfile` = `ExtensionProfiles.OneByte`

***

### extensions

> **extensions**: [`Extension`](../type-aliases/Extension.md)[] = `[]`

***

### marker

> **marker**: `boolean` = `false`

***

### padding

> **padding**: `boolean` = `false`

***

### paddingSize

> **paddingSize**: `number` = `0`

***

### payloadOffset

> **payloadOffset**: `number` = `0`

***

### payloadType

> **payloadType**: `number` = `0`

***

### sequenceNumber

> **sequenceNumber**: `number` = `0`

16bit, 初期値はランダムである必要があります

***

### ssrc

> **ssrc**: `number` = `0`

***

### timestamp

> **timestamp**: `number` = `0`

32bit microsec (milli/1000), 初期値はランダムである必要があります

***

### version

> **version**: `number` = `2`

## Accessors

### serializeSize

> `get` **serializeSize**(): `number`

#### Returns

`number`

## Methods

### serialize()

> **serialize**(`size`): `Buffer`

#### Parameters

• **size**: `number`

#### Returns

`Buffer`

***

### deSerialize()

> `static` **deSerialize**(`rawPacket`): [`RtpHeader`](RtpHeader.md)

#### Parameters

• **rawPacket**: `Buffer`

#### Returns

[`RtpHeader`](RtpHeader.md)

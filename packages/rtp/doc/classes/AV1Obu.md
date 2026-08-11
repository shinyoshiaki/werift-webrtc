[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / AV1Obu

# Class: AV1Obu

## Constructors

### new AV1Obu()

> **new AV1Obu**(): [`AV1Obu`](AV1Obu.md)

#### Returns

[`AV1Obu`](AV1Obu.md)

## Properties

### extension\_header?

> `optional` **extension\_header**: `number`

Present when obu_extension_flag=1 (TID/SID byte).

***

### obu\_extension\_flag

> **obu\_extension\_flag**: `number`

***

### obu\_forbidden\_bit

> **obu\_forbidden\_bit**: `number`

***

### obu\_has\_size\_field

> **obu\_has\_size\_field**: `number`

***

### obu\_reserved\_1bit

> **obu\_reserved\_1bit**: `number`

***

### obu\_type

> **obu\_type**: `OBU_TYPE`

***

### payload

> **payload**: `Buffer`

OBU payload body only (LEB128 size field is not part of payload).

## Methods

### serialize()

> **serialize**(): `Buffer`\<`ArrayBuffer`\>

#### Returns

`Buffer`\<`ArrayBuffer`\>

***

### deSerialize()

> `static` **deSerialize**(`buf`): [`AV1Obu`](AV1Obu.md)

Parse one OBU element.
When `obu_has_size_field` is set, consumes LEB128 size and takes exactly
that many payload octets (AV1 bitstream / AV1 RTP OBU element).

#### Parameters

##### buf

`Buffer`

#### Returns

[`AV1Obu`](AV1Obu.md)

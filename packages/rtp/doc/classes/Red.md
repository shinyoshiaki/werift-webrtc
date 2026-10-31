[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / Red

# Class: Red

## Constructors

### Constructor

> **new Red**(): `Red`

#### Returns

`Red`

## Properties

### blocks

> **blocks**: `object`[] = `[]`

#### block

> **block**: `Buffer`

#### blockPT

> **blockPT**: `number`

#### timestampOffset?

> `optional` **timestampOffset?**: `number`

14bit

***

### header

> **header**: [`RedHeader`](RedHeader.md)

## Methods

### serialize()

> **serialize**(): `Buffer`\<`ArrayBuffer`\>

#### Returns

`Buffer`\<`ArrayBuffer`\>

***

### deSerialize()

> `static` **deSerialize**(`bufferOrArrayBuffer`): `Red`

#### Parameters

##### bufferOrArrayBuffer

`ArrayBuffer` \| `Buffer`\<`ArrayBufferLike`\>

#### Returns

`Red`

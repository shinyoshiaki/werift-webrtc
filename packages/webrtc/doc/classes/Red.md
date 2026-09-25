[**werift**](../README.md)

***

[werift](../globals.md) / Red

# Class: Red

## Constructors

### new Red()

> **new Red**(): [`Red`](Red.md)

#### Returns

[`Red`](Red.md)

## Properties

### blocks

> **blocks**: `object`[] = `[]`

#### block

> **block**: `Buffer`

#### blockPT

> **blockPT**: `number`

#### timestampOffset?

> `optional` **timestampOffset**: `number`

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

> `static` **deSerialize**(`bufferOrArrayBuffer`): [`Red`](Red.md)

#### Parameters

##### bufferOrArrayBuffer

`ArrayBuffer` | `Buffer`\<`ArrayBufferLike`\>

#### Returns

[`Red`](Red.md)

[**werift**](../README.md)

***

[werift](../globals.md) / H265RtpPayload

# Class: H265RtpPayload

## Implements

- [`DePacketizerBase`](DePacketizerBase.md)

## Constructors

### new H265RtpPayload()

> **new H265RtpPayload**(): [`H265RtpPayload`](H265RtpPayload.md)

#### Returns

[`H265RtpPayload`](H265RtpPayload.md)

## Properties

### e

> **e**: `number` = `0`

FU end bit (E).

***

### f

> **f**: `number` = `0`

***

### fragment?

> `optional` **fragment**: `Buffer`\<`ArrayBufferLike`\>

#### Implementation of

[`DePacketizerBase`](DePacketizerBase.md).[`fragment`](DePacketizerBase.md#fragment)

***

### fuType

> **fuType**: `number` = `0`

FU FuType (original NAL type).

***

### layerId

> **layerId**: `number` = `0`

***

### payload

> **payload**: `Buffer`

#### Implementation of

[`DePacketizerBase`](DePacketizerBase.md).[`payload`](DePacketizerBase.md#payload)

***

### s

> **s**: `number` = `0`

FU start bit (S).

***

### tid

> **tid**: `number` = `0`

***

### type

> **type**: `number` = `0`

## Accessors

### isKeyframe

#### Get Signature

> **get** **isKeyframe**(): `boolean`

##### Returns

`boolean`

#### Implementation of

[`DePacketizerBase`](DePacketizerBase.md).[`isKeyframe`](DePacketizerBase.md#iskeyframe)

***

### isPartitionHead

#### Get Signature

> **get** **isPartitionHead**(): `boolean`

##### Returns

`boolean`

## Methods

### deSerialize()

> `static` **deSerialize**(`buf`, `fragment`?, `options`?): [`H265RtpPayload`](H265RtpPayload.md)

#### Parameters

##### buf

`Buffer`

##### fragment?

`Buffer`\<`ArrayBufferLike`\>

##### options?

[`H265DepacketizerOptions`](../type-aliases/H265DepacketizerOptions.md) = `{}`

#### Returns

[`H265RtpPayload`](H265RtpPayload.md)

***

### isDetectedFinalPacketInSequence()

> `static` **isDetectedFinalPacketInSequence**(`header`): `boolean`

#### Parameters

##### header

[`RtpHeader`](RtpHeader.md)

#### Returns

`boolean`

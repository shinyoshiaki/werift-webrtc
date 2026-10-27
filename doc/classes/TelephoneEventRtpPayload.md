[**werift**](../README.md)

***

[werift](../globals.md) / TelephoneEventRtpPayload

# Class: TelephoneEventRtpPayload

RFC 4733 named telephone event payload.
Bidirectional: deSerialize + serialize (unlike most codec depacketizers).

## Constructors

### new TelephoneEventRtpPayload()

> **new TelephoneEventRtpPayload**(`props`): [`TelephoneEventRtpPayload`](TelephoneEventRtpPayload.md)

#### Parameters

##### props

`Partial`\<[`TelephoneEventFields`](../type-aliases/TelephoneEventFields.md) & `object`\> = `{}`

#### Returns

[`TelephoneEventRtpPayload`](TelephoneEventRtpPayload.md)

## Properties

### duration

> **duration**: `number` = `0`

***

### end

> **end**: `boolean` = `false`

***

### event

> **event**: `number` = `0`

***

### reserved

> **reserved**: `boolean` = `false`

Reserved bit; receivers MUST ignore, senders SHOULD set 0.

***

### volume

> **volume**: `number` = `0`

## Accessors

### isKeyframe

#### Get Signature

> **get** **isKeyframe**(): `boolean`

##### Returns

`boolean`

***

### payload

#### Get Signature

> **get** **payload**(): `Buffer`

##### Returns

`Buffer`

## Methods

### serialize()

> **serialize**(): `Buffer`

Serialize to 4-byte payload (RFC 4733 §2.3).

#### Returns

`Buffer`

***

### deSerialize()

> `static` **deSerialize**(`buf`): [`TelephoneEventRtpPayload`](TelephoneEventRtpPayload.md)

Parse a 4-byte telephone-event payload (RFC 4733 §2.3).

#### Parameters

##### buf

`Buffer`

#### Returns

[`TelephoneEventRtpPayload`](TelephoneEventRtpPayload.md)

#### Throws

if buffer is shorter than 4 bytes.

***

### isDetectedFinalPacketInSequence()

> `static` **isDetectedFinalPacketInSequence**(`_header`): `boolean`

Not used for frame aggregation — single-packet primitive.
Kept for interface familiarity; always returns true.

#### Parameters

##### \_header

[`RtpHeader`](RtpHeader.md)

#### Returns

`boolean`

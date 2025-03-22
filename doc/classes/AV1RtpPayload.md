[**werift**](../README.md) • **Docs**

***

[werift](../globals.md) / AV1RtpPayload

# Class: AV1RtpPayload

## Constructors

### new AV1RtpPayload()

> **new AV1RtpPayload**(): [`AV1RtpPayload`](AV1RtpPayload.md)

#### Returns

[`AV1RtpPayload`](AV1RtpPayload.md)

## Properties

### nBit\_RtpStartsNewCodedVideoSequence

> **nBit\_RtpStartsNewCodedVideoSequence**: `number`

RtpStartsNewCodedVideoSequence
MUST be set to 1 if the packet is the first packet of a coded video sequence, and MUST be set to 0 otherwise.

***

### obu\_or\_fragment

> **obu\_or\_fragment**: `object`[] = `[]`

***

### w\_RtpNumObus

> **w\_RtpNumObus**: `number`

RtpNumObus
two bit field that describes the number of OBU elements in the packet. This field MUST be set equal to 0 or equal to the number of OBU elements contained in the packet. If set to 0, each OBU element MUST be preceded by a length field.

***

### yBit\_RtpEndsWithFragment

> **yBit\_RtpEndsWithFragment**: `number`

RtpEndsWithFragment
MUST be set to 1 if the last OBU element is an OBU fragment that will continue in the next packet, and MUST be set to 0 otherwise.

***

### zBit\_RtpStartsWithFragment

> **zBit\_RtpStartsWithFragment**: `number`

RtpStartsWithFragment
MUST be set to 1 if the first OBU element is an OBU fragment that is a continuation of an OBU fragment from the previous packet, and MUST be set to 0 otherwise.

## Accessors

### isKeyframe

> `get` **isKeyframe**(): `boolean`

#### Returns

`boolean`

## Methods

### deSerialize()

> `static` **deSerialize**(`buf`): [`AV1RtpPayload`](AV1RtpPayload.md)

#### Parameters

• **buf**: `Buffer`

#### Returns

[`AV1RtpPayload`](AV1RtpPayload.md)

***

### getFrame()

> `static` **getFrame**(`payloads`): `Buffer`

#### Parameters

• **payloads**: [`AV1RtpPayload`](AV1RtpPayload.md)[]

#### Returns

`Buffer`

***

### isDetectedFinalPacketInSequence()

> `static` **isDetectedFinalPacketInSequence**(`header`): `boolean`

#### Parameters

• **header**: [`RtpHeader`](RtpHeader.md)

#### Returns

`boolean`

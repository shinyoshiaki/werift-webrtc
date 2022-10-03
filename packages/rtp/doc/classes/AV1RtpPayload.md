[werift-rtp](../README.md) / [Exports](../modules.md) / AV1RtpPayload

# Class: AV1RtpPayload

## Table of contents

### Constructors

- [constructor](AV1RtpPayload.md#constructor)

### Properties

- [nBit\_RtpStartsNewCodedVideoSequence](AV1RtpPayload.md#nbit_rtpstartsnewcodedvideosequence)
- [obu\_or\_fragment](AV1RtpPayload.md#obu_or_fragment)
- [w\_RtpNumObus](AV1RtpPayload.md#w_rtpnumobus)
- [yBit\_RtpEndsWithFragment](AV1RtpPayload.md#ybit_rtpendswithfragment)
- [zBit\_RtpStartsWithFragment](AV1RtpPayload.md#zbit_rtpstartswithfragment)

### Accessors

- [isKeyframe](AV1RtpPayload.md#iskeyframe)

### Methods

- [deSerialize](AV1RtpPayload.md#deserialize)
- [getFrame](AV1RtpPayload.md#getframe)
- [isDetectedFinalPacketInSequence](AV1RtpPayload.md#isdetectedfinalpacketinsequence)

## Constructors

### constructor

• **new AV1RtpPayload**()

## Properties

### nBit\_RtpStartsNewCodedVideoSequence

• **nBit\_RtpStartsNewCodedVideoSequence**: `number`

RtpStartsNewCodedVideoSequence
MUST be set to 1 if the packet is the first packet of a coded video sequence, and MUST be set to 0 otherwise.

___

### obu\_or\_fragment

• **obu\_or\_fragment**: { `data`: `Buffer` ; `isFragment`: `boolean`  }[] = `[]`

___

### w\_RtpNumObus

• **w\_RtpNumObus**: `number`

RtpNumObus
two bit field that describes the number of OBU elements in the packet. This field MUST be set equal to 0 or equal to the number of OBU elements contained in the packet. If set to 0, each OBU element MUST be preceded by a length field.

___

### yBit\_RtpEndsWithFragment

• **yBit\_RtpEndsWithFragment**: `number`

RtpEndsWithFragment
MUST be set to 1 if the last OBU element is an OBU fragment that will continue in the next packet, and MUST be set to 0 otherwise.

___

### zBit\_RtpStartsWithFragment

• **zBit\_RtpStartsWithFragment**: `number`

RtpStartsWithFragment
MUST be set to 1 if the first OBU element is an OBU fragment that is a continuation of an OBU fragment from the previous packet, and MUST be set to 0 otherwise.

## Accessors

### isKeyframe

• `get` **isKeyframe**(): `boolean`

#### Returns

`boolean`

## Methods

### deSerialize

▸ `Static` **deSerialize**(`buf`): [`AV1RtpPayload`](AV1RtpPayload.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `buf` | `Buffer` |

#### Returns

[`AV1RtpPayload`](AV1RtpPayload.md)

___

### getFrame

▸ `Static` **getFrame**(`payloads`): `Buffer`

#### Parameters

| Name | Type |
| :------ | :------ |
| `payloads` | [`AV1RtpPayload`](AV1RtpPayload.md)[] |

#### Returns

`Buffer`

___

### isDetectedFinalPacketInSequence

▸ `Static` **isDetectedFinalPacketInSequence**(`header`): `boolean`

#### Parameters

| Name | Type |
| :------ | :------ |
| `header` | [`RtpHeader`](RtpHeader.md) |

#### Returns

`boolean`

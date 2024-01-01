[werift](../README.md) / [Exports](../modules.md) / RTCRtpCodecParameters

# Class: RTCRtpCodecParameters

## Table of contents

### Constructors

- [constructor](RTCRtpCodecParameters.md#constructor)

### Properties

- [channels](RTCRtpCodecParameters.md#channels)
- [clockRate](RTCRtpCodecParameters.md#clockrate)
- [direction](RTCRtpCodecParameters.md#direction)
- [mimeType](RTCRtpCodecParameters.md#mimetype)
- [parameters](RTCRtpCodecParameters.md#parameters)
- [payloadType](RTCRtpCodecParameters.md#payloadtype)
- [rtcpFeedback](RTCRtpCodecParameters.md#rtcpfeedback)

### Accessors

- [contentType](RTCRtpCodecParameters.md#contenttype)
- [name](RTCRtpCodecParameters.md#name)
- [str](RTCRtpCodecParameters.md#str)

## Constructors

### constructor

• **new RTCRtpCodecParameters**(`props`): [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Pick`\<[`RTCRtpCodecParameters`](RTCRtpCodecParameters.md), ``"mimeType"`` \| ``"clockRate"``\> & `Partial`\<[`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)\> |

#### Returns

[`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)

## Properties

### channels

• `Optional` **channels**: `number`

___

### clockRate

• **clockRate**: `number`

___

### direction

• **direction**: ``"inactive"`` \| ``"sendonly"`` \| ``"recvonly"`` \| ``"sendrecv"`` \| ``"all"`` = `"all"`

___

### mimeType

• **mimeType**: `string`

___

### parameters

• `Optional` **parameters**: `string`

___

### payloadType

• **payloadType**: `number`

When specifying a codec with a fixed payloadType such as PCMU,
it is necessary to set the correct PayloadType in RTCRtpCodecParameters in advance.

___

### rtcpFeedback

• **rtcpFeedback**: [`RTCPFB`](../modules.md#rtcpfb)[] = `[]`

## Accessors

### contentType

• `get` **contentType**(): `string`

#### Returns

`string`

___

### name

• `get` **name**(): `string`

#### Returns

`string`

___

### str

• `get` **str**(): `string`

#### Returns

`string`

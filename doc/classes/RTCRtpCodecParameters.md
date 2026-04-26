[**werift**](../README.md) • **Docs**

***

[werift](../globals.md) / RTCRtpCodecParameters

# Class: RTCRtpCodecParameters

## Constructors

### new RTCRtpCodecParameters()

> **new RTCRtpCodecParameters**(`props`): [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)

#### Parameters

• **props**: `Pick`\<[`RTCRtpCodecParameters`](RTCRtpCodecParameters.md), `"mimeType"` \| `"clockRate"`\> & `Partial`\<[`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)\>

#### Returns

[`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)

## Properties

### channels?

> `optional` **channels**: `number`

***

### clockRate

> **clockRate**: `number`

***

### direction

> **direction**: `"inactive"` \| `"sendonly"` \| `"recvonly"` \| `"sendrecv"` \| `"all"` = `"all"`

***

### mimeType

> **mimeType**: `string`

***

### parameters?

> `optional` **parameters**: `string`

***

### payloadType

> **payloadType**: `number`

When specifying a codec with a fixed payloadType such as PCMU,
it is necessary to set the correct PayloadType in RTCRtpCodecParameters in advance.

***

### rtcpFeedback

> **rtcpFeedback**: [`RTCPFB`](../type-aliases/RTCPFB.md)[] = `[]`

## Accessors

### contentType

> `get` **contentType**(): `string`

#### Returns

`string`

***

### name

> `get` **name**(): `string`

#### Returns

`string`

***

### str

> `get` **str**(): `string`

#### Returns

`string`

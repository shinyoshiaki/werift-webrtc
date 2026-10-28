[**werift**](../README.md)

***

[werift](../globals.md) / RTCRtpCodecParameters

# Class: RTCRtpCodecParameters

## Constructors

### Constructor

> **new RTCRtpCodecParameters**(`props`): `RTCRtpCodecParameters`

#### Parameters

##### props

`Pick`\<`RTCRtpCodecParameters`, `"clockRate"` \| `"mimeType"`\> & `Partial`\<`RTCRtpCodecParameters`\>

#### Returns

`RTCRtpCodecParameters`

## Properties

### channels?

> `optional` **channels?**: `number`

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

> `optional` **parameters?**: `string`

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

#### Get Signature

> **get** **contentType**(): `string`

##### Returns

`string`

***

### name

#### Get Signature

> **get** **name**(): `string`

##### Returns

`string`

***

### str

#### Get Signature

> **get** **str**(): `string`

##### Returns

`string`

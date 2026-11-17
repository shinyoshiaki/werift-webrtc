[**werift**](../README.md)

***

[werift](../globals.md) / isCodecCompatible

# Function: isCodecCompatible()

> **isCodecCompatible**(`source`, `configured`): `boolean`

Whether `source` (a track's codec or a remote codec) can be carried as
`configured`: the same MIME type, clock rate and channels, and the same
format-identifying parameters (`FORMAT_PARAMETERS`: H264 mode / profile,
VP9 profile, AV1 profile). A parameter omitted on either side matches any
value.

## Parameters

### source

[`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)

### configured

[`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)

## Returns

`boolean`

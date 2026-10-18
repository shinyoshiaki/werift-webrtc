[**werift**](../README.md)

***

[werift](../globals.md) / hasCommonPrimaryMimeType

# Function: hasCommonPrimaryMimeType()

> **hasCommonPrimaryMimeType**(`local`, `remote`): `boolean`

RTX / RED を除く primary codec に MIME 一致が 1 つでもあるか。
remote m-line を local capability で扱えるかの判定 (Issue #705) に使う。

## Parameters

### local

readonly [`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)[]

### remote

readonly [`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)[]

## Returns

`boolean`

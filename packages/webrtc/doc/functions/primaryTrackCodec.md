[**werift**](../README.md)

***

[werift](../globals.md) / primaryTrackCodec

# Function: primaryTrackCodec()

> **primaryTrackCodec**(`kind`, `negotiated`): [`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md) \| `undefined`

交渉済み codec 列から remote track の codec を決める。
先頭の RTX (と video の RED / FEC) は飛ばし、audio の RED は
[deliveredTrackCodec](deliveredTrackCodec.md) と同じく primary へ解決する。

## Parameters

### kind

`string`

### negotiated

readonly [`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)[]

## Returns

[`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md) \| `undefined`

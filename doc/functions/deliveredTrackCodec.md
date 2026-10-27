[**werift**](../README.md)

***

[werift](../globals.md) / deliveredTrackCodec

# Function: deliveredTrackCodec()

> **deliveredTrackCodec**(`kind`, `codec`, `negotiated`): `undefined` \| [`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)

remote track が実際に配信する codec を返す。
audio の RED は RTCRtpReceiver が primary へ展開してから track へ渡すため、
RED が参照する primary codec (不明なら先頭の primary) を track の codec とする。

## Parameters

### kind

`string`

### codec

`undefined` | [`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)

### negotiated

readonly [`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)[]

## Returns

`undefined` \| [`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)

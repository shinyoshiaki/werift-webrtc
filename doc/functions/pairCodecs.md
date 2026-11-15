[**werift**](../README.md)

***

[werift](../globals.md) / pairCodecs

# Function: pairCodecs()

> **pairCodecs**(`configured`, `others`, `accept?`): `Map`\<[`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md), [`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)\>

Pair each configured primary codec with at most one of `others` (and each
of `others` with at most one configured codec), the rule negotiation
(`setRemoteDescription()` / `createAnswer()`) and a later offer share:
first the codec of the same format (`isCodecCompatible`: MIME type, clock
rate, channels, H264 `packetization-mode` / `profile-level-id`), then, for
a configured codec still unpaired, one of the same MIME type
(`negotiatesAs`, for instance an H264 of another level). So when the
configured codecs hold several formats of one MIME type (H264 mode 0 and
mode 1), each pairs with its own format and an answer does not switch the
format the offer meant. RTX / RED are not paired. `accept` limits the
candidates (a fixed track source).

## Parameters

### configured

readonly [`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)[]

### others

readonly [`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)[]

### accept?

(`configured`, `other`) => `boolean`

## Returns

`Map`\<[`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md), [`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)\>

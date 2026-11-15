[**werift**](../README.md)

***

[werift](../globals.md) / pairCodecs

# Function: pairCodecs()

> **pairCodecs**(`configured`, `others`, `accept?`): `Map`\<[`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md), [`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)\>

Pair each configured primary codec with at most one of `others` (and each
of `others` with at most one configured codec), the rule negotiation
(`setRemoteDescription()` / `createAnswer()`) and a later offer share,
in three passes over the configured codecs, each pass only for the codecs
still unpaired:

1. the codec of exactly the same format (`sameFormat`: MIME type, clock
   rate, channels and every `a=fmtp` parameter, for any codec: VP9
   `profile-id`, AV1 `profile`, H264 `packetization-mode` /
   `profile-level-id`, Opus parameters, ...);
2. a compatible one (`isCodecCompatible`: the same format-identifying
   parameters, H264 mode / profile, VP9 / AV1 profile, where an omitted
   one matches any value);
3. one of the same MIME type (`negotiatesAs`, for instance an H264 of
   another level or a VP9 of another profile).

So when the configured codecs hold several formats of one MIME type (H264
mode 0 and mode 1, VP9 profile 0 and profile 2), each pairs with its own
format whatever the order, and an answer does not switch the format the
offer meant. RTX / RED are not paired. `accept` limits the candidates (a
fixed track source).

## Parameters

### configured

readonly [`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)[]

### others

readonly [`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)[]

### accept?

(`configured`, `other`) => `boolean`

## Returns

`Map`\<[`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md), [`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)\>

[**werift**](../README.md)

***

[werift](../globals.md) / useH264

# Function: useH264()

> **useH264**(`props?`): [`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)

H.264 (RFC 6184). SDP encoding name must be **`H264`** (case-sensitive for
Chrome-as-answerer software encode). Lowercase `h264` in a=rtpmap causes
Chrome to negotiate H.264 but emit zero outbound RTP packets.

## Parameters

### props?

`Partial`\<[`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)\> = `{}`

## Returns

[`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)

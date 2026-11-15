[**werift**](../README.md)

***

[werift](../globals.md) / negotiatesAs

# Function: negotiatesAs()

> **negotiatesAs**(`configured`, `negotiated`): `boolean`

The predicate negotiation pairs a configured codec with a remote one by
(`setRemoteDescription()` / `createAnswer()`): the same MIME type. The
negotiated codec is therefore in the remote's form (payload type, fmtp,
rtcp-fb), which may differ from the configured one, but it is what the
configured codec negotiated, so a later offer lists it as it is
(RFC 3264 §8.3.2).

## Parameters

### configured

[`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)

### negotiated

[`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)

## Returns

`boolean`

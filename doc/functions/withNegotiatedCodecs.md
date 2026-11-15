[**werift**](../README.md)

***

[werift](../globals.md) / withNegotiatedCodecs

# Function: withNegotiatedCodecs()

> **withNegotiatedCodecs**(`eligible`, `capability`, `negotiated`): [`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)[]

Configured codecs a negotiated m-line offers, before payload types are
mapped (`keepNegotiatedPayloadTypes`): `capability` plus the configured
counterpart (`negotiatesAs`, the predicate negotiation pairs by) of every
negotiated codec that `capability` lacks.

`eligible` is every configured codec of the kind with the fixed source and
the codec preferences applied but no direction filter, and `capability` is
the same for the current direction. A direction change (`direction`,
`removeTrack()`) therefore never takes a negotiated codec off the m-line;
only an answer does. Preferences and a fixed source still exclude one. An
RTX / RED is kept when its primaries are and it is in `capability` or
negotiated for the same primaries. The order is that of `eligible`
(preferences, then configuration), the order of a first offer.

## Parameters

### eligible

readonly [`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)[]

### capability

readonly [`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)[]

### negotiated

readonly [`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)[]

## Returns

[`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)[]

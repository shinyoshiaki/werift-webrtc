[**werift**](../README.md)

***

[werift](../globals.md) / keepNegotiatedPayloadTypes

# Function: keepNegotiatedPayloadTypes()

> **keepNegotiatedPayloadTypes**(`capability`, `negotiated`, `taken`): [`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)[]

Offer codecs for a negotiated m-line (RFC 8829 §5.2.2, RFC 3264 §8.3.2):
`capability` (configured codecs, in offer order) with each configured codec
that is already negotiated replaced by the negotiated codec itself, so its
payload type, fmtp and rtcp-fb stay as negotiated (also when the remote's
form differs from the configured one). A configured codec pairs with the
negotiated codec of the same format (`isCodecCompatible`) first, then with
one negotiation pairs it with (`negotiatesAs`, the same MIME type). A
configured codec of the MIME type of a negotiated codec that another
configured codec already stands for is not offered again, so an answer
cannot pair it in place of the negotiated one. A negotiated RTX / RED for
the offered primaries is offered as negotiated too.

A codec offered again keeps its configured payload type unless that type is
already used on this m-line or maps to another codec in `taken` (every
payload type the session uses; the same codec with other format parameters
or RTCP feedback, such as a RED with other primaries, is another codec);
then it takes a free dynamic type (96-127,
then 35-63). RTX `apt` and RED references follow their primaries, and an
RTX / RED whose primary is not offered is dropped. The order of
`capability` is kept.

## Parameters

### capability

readonly [`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)[]

### negotiated

readonly [`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)[]

### taken

`ReadonlyMap`\<`number`, [`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)\>

## Returns

[`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)[]

[**werift**](../README.md)

***

[werift](../globals.md) / keepNegotiatedPayloadTypes

# Function: keepNegotiatedPayloadTypes()

> **keepNegotiatedPayloadTypes**(`capability`, `negotiated`, `taken`): [`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)[]

Offer codecs for a negotiated m-line (RFC 8829 §5.2.2, RFC 3264 §8.3.2):
`capability` (configured payload types, in offer order) with each codec
that is already negotiated moved to its negotiated payload type.

A codec offered again keeps its configured payload type unless that type is
already used on this m-line or maps to another codec in `taken` (every
payload type the session uses; the same codec with other format parameters,
such as a RED with other primaries, is another codec); then it takes a free dynamic type (96-127,
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

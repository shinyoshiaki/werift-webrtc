[**werift**](../README.md)

***

[werift](../globals.md) / RouterTableSnapshot

# Interface: RouterTableSnapshot

## Properties

### extIdUriMap

> **extIdUriMap**: `object`

#### Index Signature

\[`id`: `number`\]: `string`

***

### midTable

> **midTable**: `object`

#### Index Signature

\[`mid`: `string`\]: [`RTCRtpReceiver`](../classes/RTCRtpReceiver.md)

***

### ridTable

> **ridTable**: `object`

#### Index Signature

\[`rid`: `string`\]: [`RTCRtpSender`](../classes/RTCRtpSender.md) \| [`RTCRtpReceiver`](../classes/RTCRtpReceiver.md)

***

### ssrcTable

> **ssrcTable**: `object`

#### Index Signature

\[`ssrc`: `number`\]: [`RTCRtpSender`](../classes/RTCRtpSender.md) \| [`RTCRtpReceiver`](../classes/RTCRtpReceiver.md)

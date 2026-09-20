[**werift**](../README.md)

***

[werift](../globals.md) / RtpReceiverMediaSnapshot

# Interface: RtpReceiverMediaSnapshot

## Properties

### codecs

> **codecs**: `object`

#### Index Signature

\[`pt`: `number`\]: [`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)

***

### lastSRtimestamp

> **lastSRtimestamp**: `object`

#### Index Signature

\[`ssrc`: `number`\]: `number`

***

### latestRepairedRid?

> `optional` **latestRepairedRid**: `string`

***

### latestRid?

> `optional` **latestRid**: `string`

***

### nack

> **nack**: `NackMediaSnapshot`

***

### nackCountBySsrc

> **nackCountBySsrc**: `object`

#### Index Signature

\[`ssrc`: `number`\]: `number`

***

### pliCountBySsrc

> **pliCountBySsrc**: `object`

#### Index Signature

\[`ssrc`: `number`\]: `number`

***

### receiveLastSRTimestamp

> **receiveLastSRTimestamp**: `object`

#### Index Signature

\[`ssrc`: `number`\]: `number`

***

### receiverTWCC?

> `optional` **receiverTWCC**: `ReceiverTWCC`

***

### remoteOctetCountBySsrc

> **remoteOctetCountBySsrc**: `object`

#### Index Signature

\[`ssrc`: `number`\]: `number`

***

### remotePacketCountBySsrc

> **remotePacketCountBySsrc**: `object`

#### Index Signature

\[`ssrc`: `number`\]: `number`

***

### remoteStreamId?

> `optional` **remoteStreamId**: `string`

***

### remoteStreamIds

> **remoteStreamIds**: `string`[]

***

### remoteStreams

> **remoteStreams**: `object`

packet-driven statistics keyed by SSRC (new keys are dropped on restore)

#### Index Signature

\[`ssrc`: `number`\]: `StreamStatistics`

***

### remoteTimestampsBySsrc

> **remoteTimestampsBySsrc**: `object`

#### Index Signature

\[`ssrc`: `number`\]: `number`

***

### remoteTrackId?

> `optional` **remoteTrackId**: `string`

***

### rtcpRunning

> **rtcpRunning**: `boolean`

***

### sdesMid?

> `optional` **sdesMid**: `string`

***

### senderReportsReceivedBySsrc

> **senderReportsReceivedBySsrc**: `object`

#### Index Signature

\[`ssrc`: `number`\]: `number`

***

### ssrcByRtx

> **ssrcByRtx**: `object`

#### Index Signature

\[`rtxSsrc`: `number`\]: `number`

***

### trackByRID

> **trackByRID**: `object`

#### Index Signature

\[`rid`: `string`\]: [`MediaStreamTrack`](../classes/MediaStreamTrack.md)

***

### trackBySSRC

> **trackBySSRC**: `object`

#### Index Signature

\[`ssrc`: `string`\]: [`MediaStreamTrack`](../classes/MediaStreamTrack.md)

***

### tracks

> **tracks**: [`MediaStreamTrack`](../classes/MediaStreamTrack.md)[]

***

### twcc?

> `optional` **twcc**: [`TwccMediaSnapshot`](TwccMediaSnapshot.md)

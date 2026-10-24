[**werift**](../README.md)

***

[werift](../globals.md) / TwccPacketFeedback

# Interface: TwccPacketFeedback

One sent packet matched against a TWCC feedback.

## Properties

### extSeq

> **extSeq**: `number`

Extended (unwrapped) transport-wide sequence number.

***

### received

> **received**: `boolean`

False when this feedback reports the packet as not received.

***

### recvMs?

> `optional` **recvMs**: `number`

Receive time in ms on a continuous timeline (24-bit reference_time
unwrapped). `undefined` when lost or reported without a receive delta.

***

### sent

> **sent**: [`SentInfo`](SentInfo.md)

Observation recorded when the packet was sent.

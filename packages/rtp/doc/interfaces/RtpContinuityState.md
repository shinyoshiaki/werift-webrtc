[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / RtpContinuityState

# Interface: RtpContinuityState

Serializable state of [RtpContinuityRewriter](../classes/RtpContinuityRewriter.md).
Pass it to `new RtpContinuityRewriter({ state })` to carry one output
timeline over to another instance.

## Properties

### generation

> **generation**: `number`

Incremented by every `switchSource()` / `reset()`. For generation checks and debugging.

***

### highestOutputSequenceNumber?

> `optional` **highestOutputSequenceNumber**: `number`

Most advanced output sequence number (16-bit wrap aware). `undefined` until the first output.

***

### highestOutputTimestamp?

> `optional` **highestOutputTimestamp**: `number`

Most advanced output timestamp (32-bit wrap aware), tracked independently of the sequence number.

***

### pending?

> `optional` **pending**: `object`

Set by `switchSource()` until the next rewritten packet freezes the offsets.

#### timestampStep

> **timestampStep**: `number`

***

### seqOffset

> **seqOffset**: `number`

uint16 offset added to input sequence numbers of the current generation.

***

### timestampOffset

> **timestampOffset**: `number`

uint32 offset added to input timestamps of the current generation.

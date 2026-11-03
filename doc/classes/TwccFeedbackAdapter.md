[**werift**](../README.md)

***

[werift](../globals.md) / TwccFeedbackAdapter

# Class: TwccFeedbackAdapter

Normalizes TWCC feedback before any estimator sees it
(pin `TransportFeedbackAdapter`).

- Sent packets are kept by extended transport-wide sequence, in send order.
- Feedback numbers are unwrapped against the previous feedback (seeded by the
  latest sent number), never by searching generations.
- A packet reported as received is removed from history, so every sent
  packet is reported as received **at most once**. Later re-reports
  (duplicate or corrective feedback) are ignored.
- A packet reported as not received stays in history; a later feedback may
  still report it as received.

Time contract. Three times are involved, all on the caller's clock (ms):
- `SentInfo.sendingAtMs`: right before the packet is handed to ICE.
- `SentInfo.sentAtMs`: when the send completed ([onSent](#onsent) is called
  at or after this time).
- `nowMs` of [onFeedback](#onfeedback) / [prune](#prune): when the feedback arrived
  or the caller ticks.

The adapter keeps a monotonic clock: the largest `sentAtMs` / `nowMs` seen.
A packet's age is `clock - sendingAtMs`. A packet is in range while its age
is at most `maxAgeMs` and it lies less than
[kTwccFeedbackHistoryMaxSeqSpan](../variables/kTwccFeedbackHistoryMaxSeqSpan.md) behind the latest sent sequence.
[onFeedback](#onfeedback) checks every matched packet against this range at match
time, so it never returns an out-of-range packet regardless of call order.
Pruning only bounds memory.

Shared by every [BandwidthEstimator](../interfaces/BandwidthEstimator.md) that consumes TWCC (legacy, GCC).

## Constructors

### Constructor

> **new TwccFeedbackAdapter**(`maxAgeMs`): `TwccFeedbackAdapter`

#### Parameters

##### maxAgeMs

`number`

Max age (`clock - sendingAtMs`) of a packet that may
  still be matched.

#### Returns

`TwccFeedbackAdapter`

## Accessors

### latestSentSeq

#### Get Signature

> **get** **latestSentSeq**(): `number` \| `undefined`

Latest extended sequence recorded by [onSent](#onsent).

##### Returns

`number` \| `undefined`

***

### size

#### Get Signature

> **get** **size**(): `number`

Number of packets still waiting for a received report.

##### Returns

`number`

## Methods

### onFeedback()

> **onFeedback**(`feedback`, `nowMs`): [`TwccPacketFeedback`](../interfaces/TwccPacketFeedback.md)[]

Match one TWCC feedback against the send history.
Results are in extended-sequence (send) order. Packets this sender did not
send (other BUNDLE senders), already reported as received, or out of
range at match time (see time contract) are omitted.

#### Parameters

##### feedback

[`TransportWideCC`](TransportWideCC.md)

##### nowMs

`number`

Feedback arrival time; advances the clock.

#### Returns

[`TwccPacketFeedback`](../interfaces/TwccPacketFeedback.md)[]

***

### onSent()

> **onSent**(`info`): `number`

Record a sent packet. `info.wideSeq` is the extended transport-wide
sequence number and is kept exactly, even when confirmations arrive out
of order. Advances the clock to `info.sentAtMs`.

#### Parameters

##### info

[`SentInfo`](../interfaces/SentInfo.md)

#### Returns

`number`

extended sequence used as the history key

***

### prune()

> **prune**(`nowMs`): `void`

Advance the clock to `nowMs` and drop entries now out of range. Memory
bound only: [onFeedback](#onfeedback) checks the range itself.

#### Parameters

##### nowMs

`number`

#### Returns

`void`

***

### reset()

> **reset**(): `void`

#### Returns

`void`

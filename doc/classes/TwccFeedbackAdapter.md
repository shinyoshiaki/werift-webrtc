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

Shared by every [BandwidthEstimator](../interfaces/BandwidthEstimator.md) that consumes TWCC (legacy, GCC).

## Constructors

### new TwccFeedbackAdapter()

> **new TwccFeedbackAdapter**(`maxAgeMs`): [`TwccFeedbackAdapter`](TwccFeedbackAdapter.md)

#### Parameters

##### maxAgeMs

`number`

Drop history entries sent more than this long ago.

#### Returns

[`TwccFeedbackAdapter`](TwccFeedbackAdapter.md)

## Accessors

### latestSentSeq

#### Get Signature

> **get** **latestSentSeq**(): `undefined` \| `number`

Latest extended sequence recorded by [onSent](TwccFeedbackAdapter.md#onsent).

##### Returns

`undefined` \| `number`

***

### size

#### Get Signature

> **get** **size**(): `number`

Number of packets still waiting for a received report.

##### Returns

`number`

## Methods

### onFeedback()

> **onFeedback**(`feedback`): [`TwccPacketFeedback`](../interfaces/TwccPacketFeedback.md)[]

Match one TWCC feedback against the send history.
Results are in extended-sequence (send) order. Packets this sender did not
send (other BUNDLE senders) or already reported as received are omitted.

#### Parameters

##### feedback

[`TransportWideCC`](TransportWideCC.md)

#### Returns

[`TwccPacketFeedback`](../interfaces/TwccPacketFeedback.md)[]

***

### onSent()

> **onSent**(`info`): `number`

Record a sent packet. `info.wideSeq` may be extended or 16-bit; 16-bit
values only move forward.

#### Parameters

##### info

[`SentInfo`](../interfaces/SentInfo.md)

#### Returns

`number`

extended sequence used as the history key

***

### prune()

> **prune**(`nowMs`): `void`

Drop entries outside the age window or the sequence span limit.

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

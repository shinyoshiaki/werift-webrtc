[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / RtpContinuityRewriter

# Class: RtpContinuityRewriter

Keeps one continuous output RTP timeline (sequence number / timestamp)
while the input RTP source is replaced (source replacement, relays,
reconnecting upstreams).

- The first source passes through unchanged (offsets 0).
- `switchSource()` only marks the switch as pending. The first packet
  rewritten afterwards freezes the offsets so that it becomes
  `highestOutputSequenceNumber + 1` / `highestOutputTimestamp + timestampStep`.
  Every later packet of the same generation uses the same fixed offsets;
  offsets are never re-derived from per-packet deltas, so loss, duplicates,
  reordering and frames sharing one timestamp are kept as-is.
- The reference point is the most advanced output (16/32-bit wrap aware),
  not the last output, so a reordered old packet right before a switch
  cannot make the new source collide with already-sent sequence numbers.

Responsibilities left to the caller:
- SSRC: rewritten only when the `ssrc` option is set.
- Payload type: not touched. Rewrite it yourself when upstream and downstream differ.
- RTX: not handled. Translate an upstream OSN with `translateSequenceNumber()`,
  drop retransmission history on switch, and keep the RTX sequence space separate.
- Downstream NACK: no reverse mapping. Retransmit from your own history keyed
  by output sequence number.
- RTCP SR: not handled. Generate SR from the rewritten timestamp, or convert a
  forwarded SR's rtpTimestamp with `translateTimestamp()` and fix its SSRC.
- TWCC: not handled. Number transport-wide sequence numbers per transport and
  strip or replace upstream TWCC extensions.
- The state is live output state, not negotiation state: do not roll it back
  together with a session description, or already-sent sequence numbers are reused.

## Constructors

### new RtpContinuityRewriter()

> **new RtpContinuityRewriter**(`options`): [`RtpContinuityRewriter`](RtpContinuityRewriter.md)

#### Parameters

##### options

[`RtpContinuityRewriterOptions`](../interfaces/RtpContinuityRewriterOptions.md) = `{}`

#### Returns

[`RtpContinuityRewriter`](RtpContinuityRewriter.md)

## Accessors

### state

#### Get Signature

> **get** **state**(): [`RtpContinuityState`](../interfaces/RtpContinuityState.md)

A copy of the current state.

##### Returns

[`RtpContinuityState`](../interfaces/RtpContinuityState.md)

## Methods

### cancelPendingSwitch()

> **cancelPendingSwitch**(): `void`

Drop a pending switch that has not been frozen yet.

#### Returns

`void`

***

### reset()

> **reset**(): `void`

Discard the output timeline and start a new generation; the next input passes through unchanged.

#### Returns

`void`

***

### rewrite()

> **rewrite**(`packet`): [`RtpPacket`](RtpPacket.md)

Rewrite a packet without mutating the input.
Returns `packet.clone()`, which is a shallow copy: the payload Buffer and
the header's `extensions` / `csrc` arrays are shared with the input.
Only primitive header fields (sequence number, timestamp, SSRC) are rewritten.

#### Parameters

##### packet

[`RtpPacket`](RtpPacket.md)

#### Returns

[`RtpPacket`](RtpPacket.md)

***

### rewriteHeaderInPlace()

> **rewriteHeaderInPlace**(`header`): `void`

Rewrite `header` in place (sequence number, timestamp and, when the `ssrc`
option is set, SSRC). For callers that already own a cloned header.

#### Parameters

##### header

[`RtpHeader`](RtpHeader.md)

#### Returns

`void`

***

### switchSource()

> **switchSource**(`__namedParameters`): `void`

Mark a source switch. The next rewritten packet freezes the offsets.
Calling it again before that packet overrides `timestampStep` (last wins).

#### Parameters

##### \_\_namedParameters

###### timestampStep?

`number` = `1`

#### Returns

`void`

***

### toJSON()

> **toJSON**(): `Record`\<`string`, `unknown`\>

#### Returns

`Record`\<`string`, `unknown`\>

***

### translateSequenceNumber()

> **translateSequenceNumber**(`inputSeq`): `number`

Map an input sequence number of the current (frozen) generation to its output value.

#### Parameters

##### inputSeq

`number`

#### Returns

`number`

***

### translateTimestamp()

> **translateTimestamp**(`inputTimestamp`): `number`

Map an input timestamp of the current (frozen) generation to its output value.

#### Parameters

##### inputTimestamp

`number`

#### Returns

`number`

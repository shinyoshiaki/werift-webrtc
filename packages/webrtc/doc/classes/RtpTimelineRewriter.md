[**werift**](../README.md)

***

[werift](../globals.md) / RtpTimelineRewriter

# Class: RtpTimelineRewriter

Keeps one continuous downstream RTP timeline (sequence number / timestamp,
optionally SSRC / payload type) while the upstream RTP source is replaced,
for example when an upstream WebRTC connection is recreated and its RTP is
forwarded to a long-lived downstream RTP / SRTP session.

- The first source is output unchanged (except the fixed `ssrc` / `payloadType`).
- Within one source, output = input + offset, so reordering, loss and
  duplicates keep their relation.
- The first packet of a new source continues from the highest output so far:
  `sequenceNumber + 1`, `timestamp + step` (see [RtpTimestampStepMode](../type-aliases/RtpTimestampStepMode.md)).
  16-bit sequence numbers and 32-bit timestamps wrap around.
- A new source starts when the `source` key passed to [rewrite](#rewrite)
  changes, when the input SSRC changes (`switchOnSsrcChange`, default on) or
  at the next packet after [switchSource](#switchsource).
- Late packets of a replaced source (its `source` key, or its SSRC with
  `switchOnSsrcChange`) are dropped (`staleSource`). Without keys and SSRC
  changes, old and new packets cannot be told apart after [switchSource](#switchsource);
  pass a `source` key per upstream connection to drop them.
- Packets of a new source that are older (signed 16-bit sequence distance
  below 0, tracked across wraps) than its first packet are dropped
  (`beforeSourceStart`): their output would be at or before the previous
  source's output, which a downstream SRTP receiver rejects as a replay. The
  first packet and everything after it is accepted. This does not apply to
  the first source, which has nothing before it.

So the output sequence number never goes back to or repeats a number of an
earlier source, which keeps the downstream SRTP rollover counter estimation
and replay window intact.

Padding-only packets are in the media sequence space and are rewritten like
media (dropping them would leave sequence gaps), but they do not count as a
timestamp increment for `"lastDelta"`. RTX packets have their own SSRC and
sequence space: do not pass them to the same instance (restore them to the
media stream first, as werift's receiver does, or use a separate instance).
Use one instance per downstream stream (audio and video separately).

Not handled here: a decoder downstream needs a key frame of the new source,
so request one upstream (PLI / FIR, for example
`RTCRtpReceiver.sendRtcpPLI`) after a switch. Upstream RTCP Sender Reports
carry the upstream SSRC / RTP timestamps; rewrite their RTP timestamp with
[mapTimestamp](#maptimestamp) and their SSRC, or generate downstream SRs yourself.

## Constructors

### Constructor

> **new RtpTimelineRewriter**(`options?`): `RtpTimelineRewriter`

#### Parameters

##### options?

[`RtpTimelineRewriterOptions`](../interfaces/RtpTimelineRewriterOptions.md) = `{}`

#### Returns

`RtpTimelineRewriter`

## Properties

### onDrop

> `readonly` **onDrop**: [`Event`](Event.md)\<\[[`RtpPacket`](RtpPacket.md), [`RtpTimelineDropReason`](../enumerations/RtpTimelineDropReason.md)\]\>

A packet was dropped. Receives the input packet.

***

### onSourceSwitch

> `readonly` **onSourceSwitch**: [`Event`](Event.md)\<\[[`RtpTimelineSwitch`](../interfaces/RtpTimelineSwitch.md)\]\>

A new source started on the output ([RtpTimelineSwitch](../interfaces/RtpTimelineSwitch.md)).

## Accessors

### sequenceNumber

#### Get Signature

> **get** **sequenceNumber**(): `number` \| `undefined`

Last output sequence number; undefined before the first packet.

##### Returns

`number` \| `undefined`

***

### timestamp

#### Get Signature

> **get** **timestamp**(): `number` \| `undefined`

Last output timestamp; undefined before the first packet.

##### Returns

`number` \| `undefined`

## Methods

### mapTimestamp()

> **mapTimestamp**(`inputTimestamp`): `number`

Output timestamp of an input timestamp of the current source (for example
to rewrite the RTP timestamp of an upstream Sender Report). Until the first
packet of a new source is rewritten, this still uses the previous source's offset.

#### Parameters

##### inputTimestamp

`number`

#### Returns

`number`

***

### rewrite()

> **rewrite**(`packet`, `options?`): [`RtpPacket`](RtpPacket.md) \| `undefined`

Rewrite one packet onto the output timeline.

#### Parameters

##### packet

[`RtpPacket`](RtpPacket.md)

##### options?

###### source?

`unknown`

Identity of the upstream source (for example a
connection generation number). A new key starts a new source.

#### Returns

[`RtpPacket`](RtpPacket.md) \| `undefined`

the rewritten packet (a clone unless `inPlace`), or undefined when
the packet is dropped ([RtpTimelineDropReason](../enumerations/RtpTimelineDropReason.md)).

***

### switchSource()

> **switchSource**(`options?`): `void`

Start a new source at the next packet.

#### Parameters

##### options?

###### source?

`unknown`

`source` key of the new source. When given, packets
with the current key are dropped from now on; packets must then carry this key.

###### timestampStep?

`number`

Timestamp increment for this switch only,
instead of [RtpTimelineRewriterOptions.timestampStep](../interfaces/RtpTimelineRewriterOptions.md#timestampstep).

#### Returns

`void`

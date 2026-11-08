[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / Av1PacketizeOptions

# Type Alias: Av1PacketizeOptions

> **Av1PacketizeOptions** = `object`

## Properties

### frameType?

> `optional` **frameType?**: `"key"` \| `"delta"`

***

### isKeyframe?

> `optional` **isKeyframe?**: `boolean`

Keyframe flag. Does NOT by itself set the N bit (see below).

***

### startsNewCodedVideoSequence?

> `optional` **startsNewCodedVideoSequence?**: `boolean`

N bit (RFC 9628 §4.4): first packet of a new coded video sequence.
A keyframe in the middle of a sequence must not set it. When omitted,
N is set only for a keyframe whose temporal unit contains a Sequence
Header OBU (a new coded video sequence cannot start without one); pass
`false` to force it off for in-band repeated headers, `true` to force on
(e.g. when the sequence header is carried out of band).

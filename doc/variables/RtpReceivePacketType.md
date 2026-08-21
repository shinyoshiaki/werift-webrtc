[**werift**](../README.md)

***

[werift](../globals.md) / RtpReceivePacketType

# Variable: RtpReceivePacketType

> `const` **RtpReceivePacketType**: `object`

How an RTP packet is classified at the moment it is delivered on
[MediaStreamTrack.onReceiveRtp](../classes/MediaStreamTrack.md#onreceivertp).

- `media`: normal media (including RED-recovered audio blocks)
- `padding`: RFC 3550 padding-only (e.g. GCC probe). Payload is empty after
  deserialize; do not decode. TWCC/NACK still observed it.
- `retransmission`: RTX unwrapped onto the original media SSRC

## Type declaration

### media

> `readonly` **media**: `"media"` = `"media"`

### padding

> `readonly` **padding**: `"padding"` = `"padding"`

### retransmission

> `readonly` **retransmission**: `"retransmission"` = `"retransmission"`

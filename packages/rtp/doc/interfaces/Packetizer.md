[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / Packetizer

# Interface: Packetizer

Codec-agnostic packetizer contract. Extra args live on concrete types.

## Methods

### packetize()

> **packetize**(`data`, `rtpTimestamp`): [`RtpPacket`](../classes/RtpPacket.md)[]

#### Parameters

##### data

`Buffer`

##### rtpTimestamp

`number`

#### Returns

[`RtpPacket`](../classes/RtpPacket.md)[]

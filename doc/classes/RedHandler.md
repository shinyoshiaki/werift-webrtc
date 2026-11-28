[**werift**](../README.md)

***

[werift](../globals.md) / RedHandler

# Class: RedHandler

## Constructors

### Constructor

> **new RedHandler**(): `RedHandler`

#### Returns

`RedHandler`

## Methods

### push()

> **push**(`red`, `base`, `accepts?`): [`RtpPacket`](RtpPacket.md)[]

The blocks of `red` as RTP packets, without those already returned for
their sequence number. A block whose payload type `accepts` refuses is
skipped and does not use up its sequence number.

#### Parameters

##### red

[`Red`](Red.md)

##### base

[`RtpPacket`](RtpPacket.md)

##### accepts?

(`payloadType`) => `boolean`

#### Returns

[`RtpPacket`](RtpPacket.md)[]

[**werift**](../README.md)

***

[werift](../globals.md) / isPaddingOnlyRtpPacket

# Function: isPaddingOnlyRtpPacket()

> **isPaddingOnlyRtpPacket**(`packet`): `boolean`

True when the packet is RFC 3550 padding-only (no media octets).

Use only on the **canonical form after [RtpPacket.deSerialize](../classes/RtpPacket.md#deserialize)**, where
padding octets have already been stripped from `payload`. Do not use this on
the pre-send wire form where padding bytes are still in `payload`
(e.g. immediately after `appendRfc3550Padding`).

## Parameters

### packet

[`RtpPacket`](../classes/RtpPacket.md)

## Returns

`boolean`

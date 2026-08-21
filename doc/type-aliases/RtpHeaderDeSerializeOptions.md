[**werift**](../README.md)

***

[werift](../globals.md) / RtpHeaderDeSerializeOptions

# Type Alias: RtpHeaderDeSerializeOptions

> **RtpHeaderDeSerializeOptions**: `object`

## Type declaration

### validatePadding?

> `optional` **validatePadding**: `boolean`

When true (default), RFC 3550 padding length is validated:
1..`packet.length - payloadOffset`.

Pass `false` only for SRTP pre-authentication header parse
(`parseSrtpRtpHeader`). The last octet is still ciphertext then, so it
is not the RFC 3550 padding-length field. After authentication,
`finalizeSrtpRtpHeader` / `RtpPacket.deSerialize` validate it.
Normal RTP parse (including `RtpPacket.deSerialize`) must leave this
unset or true; P=1 with paddingSize=0 must be rejected.

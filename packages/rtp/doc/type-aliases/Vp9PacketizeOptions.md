[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / Vp9PacketizeOptions

# Type Alias: Vp9PacketizeOptions

> **Vp9PacketizeOptions**: `object`

## Type declaration

### frameType?

> `optional` **frameType**: `"key"` \| `"delta"`

Alias for isKeyframe false / true: "key" | "delta".

### isKeyframe?

> `optional` **isKeyframe**: `boolean`

Override keyframe (P bit). Key → P=0, delta → P=1 (RFC 9628).

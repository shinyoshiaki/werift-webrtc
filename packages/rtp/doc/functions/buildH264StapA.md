[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / buildH264StapA

# Function: buildH264StapA()

> **buildH264StapA**(`nalus`): `Buffer`

Build STAP-A payload (RFC 6184 §5.7.1 / Figure 7):
  STAP-A header (F/NRI/Type=24) + repeated [16-bit NALU size][NAL]
F = OR of F of aggregated NALs; NRI = max of NRI of aggregated NALs.

## Parameters

### nalus

`Buffer`\<`ArrayBufferLike`\>[]

## Returns

`Buffer`

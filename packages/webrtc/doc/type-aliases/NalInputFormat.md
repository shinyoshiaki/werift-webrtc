[**werift**](../README.md)

***

[werift](../globals.md) / NalInputFormat

# Type Alias: NalInputFormat

> **NalInputFormat** = `"auto"` \| `"annexb"` \| `"length-prefixed"`

Layout of video samples handed to H.264 / H.265 packetizers.
- `"annexb"`: start-code delimited NAL units.
- `"length-prefixed"`: AVCC/HVCC (`naluLengthSize`-byte big-endian lengths).
- `"auto"` (default): Annex-B when the sample begins with a start code,
  otherwise length-prefixed. A 3-byte start code `00 00 01 HH` is
  byte-identical to the 4-byte length `0x1HH`, so container-sourced
  (MP4/MKV) input should pass `"length-prefixed"` explicitly.

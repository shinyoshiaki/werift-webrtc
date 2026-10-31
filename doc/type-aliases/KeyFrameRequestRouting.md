[**werift**](../README.md)

***

[werift](../globals.md) / KeyFrameRequestRouting

# Type Alias: KeyFrameRequestRouting

> **KeyFrameRequestRouting** = `"compatible"` \| `"strict"`

Where a keyframe request (PLI / FIR) goes when no route has its target SSRC.
- `"compatible"` (default): the sender whose RTX SSRC it is, else the only
  video sender of the PeerConnection, so that a request naming the RTX
  stream, SSRC 0 or a stale SSRC still gets a keyframe.
- `"strict"`: not delivered (RFC 4585 section 6.1 / RFC 5104 section 4.3.1).

A registered target SSRC is routed as is in both modes, and the sender SSRC
of the request is never used: it names the requesting peer's own stream.

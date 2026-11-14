[**werift**](../README.md)

***

[werift](../globals.md) / CompatibilityOptionValues

# Variable: CompatibilityOptionValues

> `const` **CompatibilityOptionValues**: `object`

The constructor options of `PeerConfig` that choose between the behavior the
specifications (W3C WebRTC, JSEP, the RTP RFCs) define and browsers
implement, and werift's own behavior kept for existing applications. Each
one takes two values:
- `"standard"`: the specification / browser behavior, in every option.
- a value naming werift's own behavior in that option:
  - `certificateScope: "process"`: one default DTLS certificate shared by
    the process (`"standard"`: one per `RTCPeerConnection`).
  - `mLineReuse: "aggressive"`: an accepted `inactive` m-line is also
    written with port 0, so its position is reused (`"standard"`: it keeps
    its port).
  - `transceiverPairing: "byKind"`: a remote offer's m-section takes any
    unassociated transceiver of its kind (`"standard"`: JSEP 5.10).
  - `keyFrameRequestRouting: "fallback"`: a PLI / FIR for an unknown SSRC
    falls back to the RTX owner or the only video sender (`"standard"`: not
    delivered).

Each option documents its default and whether `setConfiguration()` may
change it. Any other value is a `TypeError`; the names used up to v0.27.0
are still accepted (see `DeprecatedCompatibilityValues` in
`api/peerConfig.ts`).

## Type Declaration

### certificateScope

> `readonly` **certificateScope**: readonly \[`"standard"`, `"process"`\]

### keyFrameRequestRouting

> `readonly` **keyFrameRequestRouting**: readonly \[`"standard"`, `"fallback"`\]

### mLineReuse

> `readonly` **mLineReuse**: readonly \[`"standard"`, `"aggressive"`\]

### transceiverPairing

> `readonly` **transceiverPairing**: readonly \[`"standard"`, `"byKind"`\]

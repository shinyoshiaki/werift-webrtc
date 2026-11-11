[**werift**](../README.md)

***

[werift](../globals.md) / BundleCandidates

# Type Alias: BundleCandidates

> **BundleCandidates** = `"compatible"` \| `"tagOnly"`

Which m-lines of a negotiated BUNDLE group carry the local ICE candidates.
- `"compatible"` (default): every m-line repeats its transport's candidates
  and `a=end-of-candidates` (legacy behavior).
- `"tagOnly"`: once an answer has negotiated BUNDLE, only the tag m-line
  carries them; the other m-lines on the same transport keep their ICE /
  DTLS parameters without candidates (RFC 8843 §7.1.3, RFC 8859).

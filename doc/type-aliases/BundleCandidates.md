[**werift**](../README.md)

***

[werift](../globals.md) / BundleCandidates

# Type Alias: BundleCandidates

> **BundleCandidates** = `"legacy"` \| `"compatible"`

Which m-lines of a BUNDLE group carry the local ICE candidates.
- `"legacy"` (default): every m-line repeats its transport's candidates
  and `a=end-of-candidates` (werift's earlier output).
- `"compatible"`: as Chrome writes them, only the m-line that owns the
  transport (the BUNDLE tag) carries them; the other m-lines on the same
  transport keep their ICE / DTLS parameters without candidates
  (RFC 8843 §7.1.3, RFC 8859).

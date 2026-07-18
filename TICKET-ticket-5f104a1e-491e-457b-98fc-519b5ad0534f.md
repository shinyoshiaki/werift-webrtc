Fixes #620

The audio RED fmtp was derived as `payloadType + 1` inside the payload type assignment loop, which is only correct when RED is listed directly before the primary codec and payload types are auto-assigned. With `[opus, red]` order the fmtp referenced a payload type that does not exist on the m-line, and with explicit payload types RED got no fmtp at all because the assignment loop skips codecs that already have one.

The fmtp is now filled in after all payload types are assigned, referencing the first non-red, non-rtx audio codec. Explicitly configured `parameters` are left untouched. Behavior for the existing `[red, opus]` case is unchanged, covered by the existing negotiation tests; two new tests cover the `[opus, red]` order and explicit payload types (111/63 as negotiated by Chrome).

`npx vitest run ./tests` in packages/webrtc: 31 files, 185 passed, 3 skipped (pre-existing skips). The two new tests fail without the src change.
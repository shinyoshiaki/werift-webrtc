## Summary
DTLS 1.2 handshake reassembly on current `develop` can assemble an incomplete ClientHello when handshake fragments arrive out of order, particularly when the fragment ending at the message length arrives before the initial fragment. A downstream production-path workaround was merged in [SimpleIM PR #26](https://github.com/zzqDeco/SimpleIM/pull/26), reporting failures with larger post-quantum `X25519MLKEM768` ClientHello messages over TURN/WAN.

## Current upstream implementation
- `packages/dtls/src/socket.ts` `handleFragmentHandshake()` buffers partial fragments, then treats the buffer as complete when the **last received** fragment satisfies `fragment_offset + fragment_length === length` and at least two fragments exist. This does not prove full byte coverage, nor that fragments belong to one `(msg_type, message_seq, length)` group.
- `packages/dtls/src/record/message/fragment.ts` `FragmentedHandshake.assemble()` sorts and copies fragments into `Buffer.alloc(messages[0].length)` without validating contiguous coverage. Missing bytes remain zero-filled.
- The resulting malformed `ClientHello` may be parsed with zeroed fields and fail cipher-suite negotiation. Out-of-order delivery, duplication and overlapping fragments require careful handling.

## Expected behavior
- Reassemble by handshake identity (at least message type, sequence and declared total length, scoped to the appropriate DTLS epoch/flight).
- Track actual byte coverage, not arrival order or whether the final offset was observed.
- Do not deliver a handshake message to the parser until the complete declared byte range is present.
- Handle out-of-order, duplicate and overlapping fragments safely; reject inconsistent overlapping bytes rather than silently accepting corrupted data.
- Bound buffered bytes, fragment count and lifetime to avoid memory exhaustion from untrusted network traffic.
- Preserve unfragmented handshakes and retransmission behavior.

## Regression tests
1. Three-fragment ClientHello with order [last, middle, first], and [middle, last, first].
2. Final fragment arrives while a gap remains: must **not** emit a reconstructed message.
3. Duplicate, overlapping, and interleaved fragments from distinct message sequences.
4. Verify the reconstructed bytes exactly match the original, including a large ClientHello.
5. DTLS client/server integration test across a lossy/reordering transport.

## Evidence and duplicate check
- Downstream: https://github.com/zzqDeco/SimpleIM/pull/26
- Upstream source: `packages/dtls/src/socket.ts`, `packages/dtls/src/record/message/fragment.ts` on `develop`.
- Searched existing upstream DTLS/fragment/reassembly issues and PRs. #659 (DTLS 1.3 roadmap) and #753 (stale ClientHello random after HelloVerifyRequest) concern different failure modes; no equivalent open PR found.

This issue targets the core DTLS fragment reassembler. The downstream PR also patches early DTLS datagram buffering during ICE startup, which is a separate concern and should not be assumed to be fixed by this issue.
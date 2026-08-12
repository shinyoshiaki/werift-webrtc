# Local BoringSSL interop evidence (Epic 1 review)

Built harness: `packages/dtls/tests/e2e/boringssl/dtls13_echo` via main-line BoringSSL
static libs under `packages/dtls/third_party/boringssl` (gitignored).

Command:
```
WERIFT_REQUIRE_BORINGSSL=1 npm run test:boringssl
```

Result: **5 passed** — werift client↔BoringSSL server and BoringSSL client↔werift server
bidirectional DTLS 1.3 data (both roles).

Review-fix coverage:
- Flight4 pre-connect wire re-inject (epoch-0 window before SHD) — `handleCalls > 0`, apply skipped
- Flight6 mid-handshake CKE duplicate wire — `!connected`, `handleCalls > 0`, masterSecret stable
- Flight6 Finished duplicate unit — cache de-dupe
- HVR stale retransmit — `activeFlight3Waiting() === 1` after gen1 exit
- Flight.transmit — `flightTxGeneration` tags send waves; stale errors ignored

re-review trigger 2026-08-12T10:49:06Z

git-status-repair 2026-08-12T10:50:45Z

re-review-after-git-env-clear 2026-08-12T10:53:31Z

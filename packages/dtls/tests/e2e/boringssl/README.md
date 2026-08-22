# BoringSSL DTLS 1.3 interop harness

P0 interop peer for Epic 1 (RFC 9147 DTLS 1.3).

The stock `bssl s_server` / `s_client` tools are TCP TLS only. Interop uses a
small native helper `dtls13_echo` linked against the **pinned BoringSSL**
libraries (`DTLS_method` + `DTLS1_3_VERSION`).

## Revision pin

| Item | Value |
| --- | --- |
| Repository | https://boringssl.googlesource.com/boringssl |
| Git revision | `a204be272595867e7069221050f19697a0cf66ad` (pin; do not use floating HEAD) |
| Helper source | `packages/dtls/tools/boringssl-dtls13/native/dtls13_echo.c` (canonical) |
| Helper binary | `tests/e2e/boringssl/dtls13_echo` (built from the tools source) |
| Pin file | `packages/dtls/tools/boringssl-dtls13/BORINGSSL_REVISION` |
| Optional tool | `bssl` (not required for DTLS interop) |

Environment overrides:

```bash
export WERIFT_BORINGSSL_INCLUDE=/path/to/boringssl/include   # default /usr/local/include
export WERIFT_BORINGSSL_LIB=/path/to/boringssl/build         # libssl.a / libcrypto.a
export WERIFT_BORINGSSL_DTLS_ECHO=/path/to/dtls13_echo
export WERIFT_BORINGSSL_BSSL=/path/to/bssl                   # optional
```

## Reproducible pin build (recommended / CI)

From `packages/dtls/tests/e2e/boringssl`:

```bash
# Clones packages/dtls/third_party/boringssl @ BORINGSSL_REVISION,
# builds libssl/libcrypto, builds dtls13_echo, writes .built-revision
./fetch-and-build-boringssl.sh
```

This is the path used by GitHub Actions job `dtls13-boringssl`. It does **not**
depend on preinstalled `/usr/local` libraries.

## Manual BoringSSL build (optional)

```bash
git clone https://github.com/google/boringssl.git
cd boringssl
git checkout "$(cat packages/dtls/tools/boringssl-dtls13/BORINGSSL_REVISION)"
mkdir -p build && cd build
cmake -GNinja -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=OFF ..
ninja ssl crypto bssl
export WERIFT_BORINGSSL_INCLUDE=.../boringssl/include
export WERIFT_BORINGSSL_LIB=.../boringssl/build  # dir with libssl.a + libcrypto.a
./build-bssl-echo.sh
```

## Run interop tests

From `packages/dtls`:

```bash
# Local without harness: tests skip with a clear reason
npm test -- ./tests/e2e/boringssl

# With harness built from pin
./tests/e2e/boringssl/fetch-and-build-boringssl.sh
npm test -- ./tests/e2e/boringssl
```

**CI policy:** job `dtls13-boringssl` always runs `fetch-and-build-boringssl.sh`
and fails if pin mismatch or harness missing (`WERIFT_REQUIRE_BORINGSSL=1`).
The main `build` job does **not** require the harness (`CI=true` alone does not
fail). Local developer runs skip when the harness binary is absent.

## Scenarios

1. **werift client × BoringSSL server** — certificate full handshake,
   `TLS_AES_128_GCM_SHA256`, X25519, bidirectional application data.
2. **BoringSSL client × werift server** — same expectations.

Failures must surface alerts / flight logs (no catch-and-ignore).

## Notes

- OpenSSL is used only for DTLS 1.2 regression, not DTLS 1.3 interop.
- SPED / ICE are out of scope for this harness (Epic 2+).
Wed Aug 12 10:22:39 UTC 2026

# BoringSSL DTLS 1.3 interop harness

P0 interop peer for Epic 1 (RFC 9147 DTLS 1.3).

The stock `bssl s_server` / `s_client` tools are TCP TLS only. Interop uses a
small native helper `dtls13_echo` linked against the **pinned BoringSSL**
libraries (`DTLS_method` + `DTLS1_3_VERSION`).

## Revision pin

| Item | Value |
| --- | --- |
| Repository | https://boringssl.googlesource.com/boringssl |
| Git revision | `0bcc1e8473a1264b4de88e05a651763dc9a71b09` (pin; do not use floating HEAD) |
| Helper binary | `tests/e2e/boringssl/dtls13_echo` |
| Optional tool | `bssl` (not required for DTLS interop) |

Environment overrides:

```bash
export WERIFT_BORINGSSL_INCLUDE=/path/to/boringssl/include   # default /usr/local/include
export WERIFT_BORINGSSL_LIB=/path/to/boringssl/build         # libssl.a / libcrypto.a
export WERIFT_BORINGSSL_DTLS_ECHO=/path/to/dtls13_echo
export WERIFT_BORINGSSL_BSSL=/path/to/bssl                   # optional
```

## Build BoringSSL (CMake + Ninja)

```bash
git clone https://boringssl.googlesource.com/boringssl
cd boringssl
git checkout 0bcc1e8473a1264b4de88e05a651763dc9a71b09
mkdir -p build && cd build
cmake -GNinja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr/local ..
ninja
# install headers + static libs, or point WERIFT_BORINGSSL_* at this tree
```

## Build the DTLS echo harness

From `packages/dtls/tests/e2e/boringssl`:

```bash
./build-bssl-echo.sh
# produces ./dtls13_echo
```

## Run interop tests

From `packages/dtls`:

```bash
# Local without harness: tests skip with a clear reason
npm test -- ./tests/e2e/boringssl

# With harness built
./tests/e2e/boringssl/build-bssl-echo.sh
npm test -- ./tests/e2e/boringssl
```

**CI policy:** required CI jobs must build `dtls13_echo` (or set
`WERIFT_BORINGSSL_DTLS_ECHO`) and fail if missing. Local developer runs skip
when the harness binary is absent.

## Scenarios

1. **werift client × BoringSSL server** — certificate full handshake,
   `TLS_AES_128_GCM_SHA256`, X25519, bidirectional application data.
2. **BoringSSL client × werift server** — same expectations.

Failures must surface alerts / flight logs (no catch-and-ignore).

## Notes

- OpenSSL is used only for DTLS 1.2 regression, not DTLS 1.3 interop.
- SPED / ICE are out of scope for this harness (Epic 2+).

#!/usr/bin/env bash
# Wrapper: pin + native source live in packages/dtls/tools/boringssl-dtls13.
# Writes dtls13_echo and .built-revision into this test directory (CI paths).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
TOOLS="$(cd "${ROOT}/../../../tools/boringssl-dtls13" && pwd)"
export WERIFT_DTLS13_ECHO_OUT="${ROOT}/dtls13_echo"
"${TOOLS}/fetch-and-build-boringssl.sh"
if [ -f "${TOOLS}/.built-revision" ]; then
  cp -f "${TOOLS}/.built-revision" "${ROOT}/.built-revision"
fi
if [ -x "${TOOLS}/dtls13_echo" ] && [ ! -x "${ROOT}/dtls13_echo" ]; then
  cp -f "${TOOLS}/dtls13_echo" "${ROOT}/dtls13_echo"
  chmod +x "${ROOT}/dtls13_echo"
fi
test -x "${ROOT}/dtls13_echo"
echo "OK: test harness ${ROOT}/dtls13_echo"

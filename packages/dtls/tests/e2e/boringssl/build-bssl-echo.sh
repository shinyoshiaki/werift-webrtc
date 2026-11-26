#!/usr/bin/env bash
# Wrapper: canonical source lives in packages/dtls/tools/boringssl-dtls13.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
TOOLS="$(cd "${ROOT}/../../../tools/boringssl-dtls13" && pwd)"
export WERIFT_DTLS13_ECHO_OUT="${ROOT}/dtls13_echo"
exec "${TOOLS}/build-bssl-echo.sh"

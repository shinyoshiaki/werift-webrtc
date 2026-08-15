#!/usr/bin/env bash
# Build native BoringSSL DTLS 1.3 echo harness for interop tests.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
OUT="${WERIFT_DTLS13_ECHO_OUT:-${ROOT}/dtls13_echo}"
SRC="${ROOT}/native/dtls13_echo.c"
OBJ="${ROOT}/dtls13_echo.o"

BSSL_INCLUDE="${WERIFT_BORINGSSL_INCLUDE:-/usr/local/include}"
BSSL_LIB="${WERIFT_BORINGSSL_LIB:-/usr/local/lib}"

echo "Building ${OUT}"
echo "  include=${BSSL_INCLUDE}"
echo "  lib=${BSSL_LIB}"
PIN_FILE="${ROOT}/BORINGSSL_REVISION"
PIN="$(tr -d '[:space:]' < "${PIN_FILE}" 2>/dev/null || true)"
echo "  pin revision: ${PIN:-see BORINGSSL_REVISION} (see README.md)"

# Compile C source, then link with g++ against BoringSSL static libs
cc -O2 -std=c11 -c \
  -I"${BSSL_INCLUDE}" \
  -o "${OBJ}" \
  "${SRC}"

c++ -O2 -o "${OUT}" "${OBJ}" \
  "${BSSL_LIB}/libssl.a" \
  "${BSSL_LIB}/libcrypto.a" \
  -lpthread -ldl

rm -f "${OBJ}"
echo "OK: ${OUT}"
"${OUT}" 2>&1 | head -3 || true

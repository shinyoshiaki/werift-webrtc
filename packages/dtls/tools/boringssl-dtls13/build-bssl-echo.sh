#!/usr/bin/env bash
# Build native BoringSSL DTLS 1.3 echo harness for interop tests.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
OUT="${ROOT}/dtls13_echo"
SRC="${ROOT}/native/dtls13_echo.c"
OBJ="${ROOT}/dtls13_echo.o"

BSSL_INCLUDE="${WERIFT_BORINGSSL_INCLUDE:-/usr/local/include}"
BSSL_LIB="${WERIFT_BORINGSSL_LIB:-/usr/local/lib}"

echo "Building ${OUT}"
echo "  include=${BSSL_INCLUDE}"
echo "  lib=${BSSL_LIB}"
echo "  pin revision: 0bcc1e8473a1264b4de88e05a651763dc9a71b09 (see README.md)"

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

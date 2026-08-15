#!/usr/bin/env bash
# Install pinned BoringSSL (bssl) + dtls13_echo as boringssl-dtls13 for sysbox/CI images.
# Consumed by Dockerfile.sysbox-base: COPY packages/dtls/tools/boringssl-dtls13 ...
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PIN_FILE="${ROOT}/BORINGSSL_REVISION"
PIN="${WERIFT_BORINGSSL_REVISION:-}"
if [ -z "${PIN}" ] && [ -f "${PIN_FILE}" ]; then
  PIN="$(tr -d '[:space:]' < "${PIN_FILE}")"
fi
if [ -z "${PIN}" ]; then
  PIN="a204be272595867e7069221050f19697a0cf66ad"
fi

# GitHub is the reliable public mirror. googlesource often returns HTTP 400/500.
REPO_URL="${WERIFT_BORINGSSL_REPO:-https://github.com/google/boringssl.git}"
SRC_ROOT="${WERIFT_BORINGSSL_SRC:-/tmp/werift-boringssl-src}"
BUILD_DIR="${SRC_ROOT}/build"
PREFIX="${WERIFT_BORINGSSL_PREFIX:-/usr/local}"

echo "BoringSSL pin: ${PIN}"
echo "Source dir:    ${SRC_ROOT}"
echo "Install prefix:${PREFIX}"

mkdir -p "$(dirname "${SRC_ROOT}")"
if [ ! -d "${SRC_ROOT}/.git" ]; then
  echo "Cloning BoringSSL..."
  if ! git clone "${REPO_URL}" "${SRC_ROOT}"; then
    echo "Primary clone failed; retrying googlesource mirror..."
    git clone https://boringssl.googlesource.com/boringssl "${SRC_ROOT}"
  fi
fi
cd "${SRC_ROOT}"
git fetch origin "${PIN}" || git fetch --depth 1 origin "${PIN}" || \
  git fetch --depth 1 https://github.com/google/boringssl.git "${PIN}" || true
git checkout --force "${PIN}"
ACTUAL="$(git rev-parse HEAD)"
if [ "${#PIN}" -ge 40 ] && [ "${ACTUAL}" != "${PIN}" ]; then
  case "${ACTUAL}" in
    ${PIN}*) ;;
    *)
      echo "ERROR: checked out ${ACTUAL}, expected pin ${PIN}"
      exit 1
      ;;
  esac
fi
echo "Verified revision: ${ACTUAL}"

if ! command -v cmake >/dev/null || ! command -v ninja >/dev/null; then
  echo "cmake/ninja required to build BoringSSL" >&2
  exit 1
fi

mkdir -p "${BUILD_DIR}"
cd "${BUILD_DIR}"
# BUILD_TESTING=OFF: BoringSSL's ssl_test does not compile under GCC 12 -Werror.
cmake -GNinja -DCMAKE_BUILD_TYPE=Release -DCMAKE_POSITION_INDEPENDENT_CODE=ON -DBUILD_TESTING=OFF ..
ninja ssl crypto bssl

# bssl tool (if built)
BSSL_BIN="$(find "${BUILD_DIR}" -type f -name bssl | head -1 || true)"
if [ -n "${BSSL_BIN}" ] && [ -x "${BSSL_BIN}" ]; then
  install -m 0755 "${BSSL_BIN}" "${PREFIX}/bin/bssl"
else
  # Some builds place it under tool/
  BSSL_BIN="$(find "${SRC_ROOT}" -type f -name bssl -path '*/tool/*' | head -1 || true)"
  if [ -n "${BSSL_BIN}" ] && [ -x "${BSSL_BIN}" ]; then
    install -m 0755 "${BSSL_BIN}" "${PREFIX}/bin/bssl"
  else
    # Ensure ninja tool target
    ninja bssl || ninja tool/bssl || true
    BSSL_BIN="$(find "${BUILD_DIR}" -type f -name bssl | head -1 || true)"
    if [ -z "${BSSL_BIN}" ] || [ ! -x "${BSSL_BIN}" ]; then
      echo "ERROR: bssl binary not found after build" >&2
      exit 1
    fi
    install -m 0755 "${BSSL_BIN}" "${PREFIX}/bin/bssl"
  fi
fi

INCLUDE_DIR="${SRC_ROOT}/include"
SSL_A="$(find "${BUILD_DIR}" -name 'libssl.a' | head -1)"
CRYPTO_A="$(find "${BUILD_DIR}" -name 'libcrypto.a' | head -1)"
if [ -z "${SSL_A}" ] || [ -z "${CRYPTO_A}" ]; then
  echo "ERROR: libssl.a / libcrypto.a not found" >&2
  exit 1
fi

mkdir -p "${PREFIX}/include" "${PREFIX}/lib"
cp -a "${INCLUDE_DIR}/." "${PREFIX}/include/"
cp -f "${SSL_A}" "${PREFIX}/lib/libssl.a"
cp -f "${CRYPTO_A}" "${PREFIX}/lib/libcrypto.a"

# Build dtls13_echo harness and install as boringssl-dtls13
export WERIFT_BORINGSSL_INCLUDE="${PREFIX}/include"
export WERIFT_BORINGSSL_LIB="${PREFIX}/lib"
chmod +x "${ROOT}/build-bssl-echo.sh"
# build-bssl-echo writes to ROOT/dtls13_echo
(
  cd "${ROOT}"
  # Patch OUT name via OUT env if needed — script hardcodes dtls13_echo
  bash ./build-bssl-echo.sh
)
install -m 0755 "${ROOT}/dtls13_echo" "${PREFIX}/bin/boringssl-dtls13"
# Also keep legacy name for local e2e
install -m 0755 "${ROOT}/dtls13_echo" "${PREFIX}/bin/dtls13_echo" || true

mkdir -p "${PREFIX}/share"
echo "${ACTUAL}" > "${PREFIX}/share/werift-boringssl-pin.txt"
echo "OK: installed bssl + boringssl-dtls13 (pin ${ACTUAL})"

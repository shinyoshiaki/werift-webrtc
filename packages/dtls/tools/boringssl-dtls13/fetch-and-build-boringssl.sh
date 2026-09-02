#!/usr/bin/env bash
# Fetch pinned BoringSSL revision, build static libs, then build dtls13_echo.
# Guarantees reproducible interop peer for CI (does not rely on preinstalled libs).
set -euo pipefail

# Nested clone must not inherit a parent work tree (SAK wrapper injects GIT_DIR).
unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE GIT_OBJECT_DIRECTORY || true

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
# tools/boringssl-dtls13 -> packages/dtls
DTLS_PKG="$(cd "${ROOT}/../.." && pwd)"
SRC_ROOT="${WERIFT_BORINGSSL_SRC:-${DTLS_PKG}/third_party/boringssl}"
BUILD_DIR="${SRC_ROOT}/build"

echo "BoringSSL pin: ${PIN}"
echo "Source dir:    ${SRC_ROOT}"

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
case "${ACTUAL}" in
  ${PIN}*) ;;
  *)
    # full hash pin must match exactly
    if [ "${#PIN}" -ge 40 ] && [ "${ACTUAL}" != "${PIN}" ]; then
      echo "ERROR: checked out ${ACTUAL}, expected pin ${PIN}"
      exit 1
    fi
    ;;
esac
echo "${ACTUAL}" > "${ROOT}/.built-revision"
echo "Verified revision: ${ACTUAL}"

if ! command -v cmake >/dev/null || ! command -v ninja >/dev/null; then
  echo "Installing cmake/ninja..."
  sudo apt-get update -qq
  sudo apt-get install -y -qq cmake ninja-build g++ git pkg-config
fi

mkdir -p "${BUILD_DIR}"
cd "${BUILD_DIR}"
# BUILD_TESTING=OFF: BoringSSL's ssl_test does not compile under GCC 12 -Werror.
# Only the static libs + bssl tool are required for werift interop.
cmake -GNinja -DCMAKE_BUILD_TYPE=Release -DCMAKE_POSITION_INDEPENDENT_CODE=ON -DBUILD_TESTING=OFF ..
ninja ssl crypto bssl

# Headers: BoringSSL uses ${SRC}/include
export WERIFT_BORINGSSL_INCLUDE="${SRC_ROOT}/include"
if [ ! -f "${WERIFT_BORINGSSL_INCLUDE}/openssl/ssl.h" ]; then
  echo "ERROR: openssl/ssl.h not found under ${WERIFT_BORINGSSL_INCLUDE}"
  exit 1
fi

SSL_A="$(find "${BUILD_DIR}" -name 'libssl.a' | head -1)"
CRYPTO_A="$(find "${BUILD_DIR}" -name 'libcrypto.a' | head -1)"
if [ -z "${SSL_A}" ] || [ -z "${CRYPTO_A}" ]; then
  echo "ERROR: libssl.a / libcrypto.a not found under ${BUILD_DIR}"
  find "${BUILD_DIR}" -name '*.a' | head -20
  exit 1
fi

# Point lib dir at a staging folder with both archives
STAGE="${BUILD_DIR}/werift-link"
mkdir -p "${STAGE}"
cp -f "${SSL_A}" "${STAGE}/libssl.a"
cp -f "${CRYPTO_A}" "${STAGE}/libcrypto.a"
export WERIFT_BORINGSSL_LIB="${STAGE}"

echo "Building dtls13_echo against pin..."
cd "${ROOT}"
chmod +x ./build-bssl-echo.sh
./build-bssl-echo.sh
ECHO_BIN="${WERIFT_DTLS13_ECHO_OUT:-${ROOT}/dtls13_echo}"
test -x "${ECHO_BIN}"

# Record pin in helpers-readable file (already .built-revision)
echo "OK: BoringSSL ${ACTUAL} + dtls13_echo ready"
echo "  include=${WERIFT_BORINGSSL_INCLUDE}"
echo "  lib=${WERIFT_BORINGSSL_LIB}"
echo "  echo=${ECHO_BIN}"

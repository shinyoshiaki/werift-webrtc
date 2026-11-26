#!/usr/bin/env bash
# Build the BoringSSL interop image and run tests inside it.
# Host git is unused: clone/build happen in the image with stock git.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="${HERE}"
while [ "${ROOT}" != "/" ]; do
  if [ -f "${ROOT}/package.json" ] && grep -q '"name": "werift"' "${ROOT}/package.json"; then
    break
  fi
  ROOT="$(cd "${ROOT}/.." && pwd)"
done
if [ ! -f "${ROOT}/package.json" ]; then
  echo "ERROR: could not find werift repository root from ${HERE}" >&2
  exit 1
fi

IMAGE="${WERIFT_BORINGSSL_DOCKER_IMAGE:-werift-dtls-boringssl-e2e:latest}"
DOCKERFILE="${HERE}/Dockerfile"

echo "Building ${IMAGE} (context ${ROOT})"
docker build -f "${DOCKERFILE}" -t "${IMAGE}" "${ROOT}"
echo "Running BoringSSL DTLS 1.3 interop tests in ${IMAGE}"
docker run --rm "${IMAGE}"

#!/bin/bash
# Build the harness against pion/webrtc#3362 (SPED, not released yet) in a
# golang:1.24 container. Output: ./pion-webrtc-sped (or $1).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="${1:-$here/pion-webrtc-sped}"
# fippo/pion-webrtc branch "sped" (pion/webrtc#3362), pinned.
PION_WEBRTC_SPED_SHA="${PION_WEBRTC_SPED_SHA:-0be1c3334a81d224f6fc69792c02040b3fa897c6}"
outdir="$(dirname "$out")"
mkdir -p "$outdir"
docker run --rm -v "$here":/src:ro -v "$outdir":/out -w /work golang:1.24 bash -c "
  set -e
  git clone -q https://github.com/fippo/pion-webrtc.git pion-webrtc
  git -C pion-webrtc checkout -q $PION_WEBRTC_SPED_SHA
  mkdir harness && cp /src/main.go /src/go.mod harness/ && cd harness
  go mod edit -replace github.com/pion/webrtc/v5=../pion-webrtc
  go mod tidy
  CGO_ENABLED=0 go build -buildvcs=false -o /out/$(basename "$out") .
"
echo "built $out"

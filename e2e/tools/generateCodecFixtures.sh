#!/usr/bin/env bash
# Generate short codec fixtures for packages/rtp Chrome E2E (scenario B).
# Development machines only — CI does NOT run this; it reads committed files under e2e/fixtures/media/.
#
# Requires: GStreamer 1.x with vp8enc, vp9enc, av1enc, x264enc, opusenc, webmmux, mp4mux.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${ROOT}/fixtures/media"
mkdir -p "${OUT}"

echo "Writing fixtures to ${OUT}"

# VP8 — ball pattern so pixel hash changes under waitVideoPlay
gst-launch-1.0 -e \
  videotestsrc num-buffers=60 pattern=ball \
  ! video/x-raw,width=320,height=240,framerate=30/1 \
  ! vp8enc deadline=1 keyframe-max-dist=30 \
  ! webmmux \
  ! filesink location="${OUT}/vp8.webm"

# VP9
gst-launch-1.0 -e \
  videotestsrc num-buffers=60 pattern=ball \
  ! video/x-raw,width=320,height=240,framerate=30/1 \
  ! vp9enc deadline=1 keyframe-max-dist=30 \
  ! webmmux \
  ! filesink location="${OUT}/vp9.webm"

# AV1
gst-launch-1.0 -e \
  videotestsrc num-buffers=45 pattern=ball \
  ! video/x-raw,width=320,height=240,framerate=15/1 \
  ! av1enc \
  ! webmmux \
  ! filesink location="${OUT}/av1.webm"

# H.264 Constrained Baseline-ish (black screen in Chrome is acceptable in E2E)
gst-launch-1.0 -e \
  videotestsrc num-buffers=60 pattern=ball \
  ! video/x-raw,width=320,height=240,framerate=30/1 \
  ! x264enc tune=zerolatency speed-preset=ultrafast key-int-max=30 \
  ! video/x-h264,profile=baseline \
  ! mp4mux \
  ! filesink location="${OUT}/h264.mp4"

# Opus
gst-launch-1.0 -e \
  audiotestsrc num-buffers=100 freq=440 \
  ! audioconvert \
  ! opusenc \
  ! webmmux \
  ! filesink location="${OUT}/opus.webm"

ls -la "${OUT}"
echo "Done. Commit the fixtures under e2e/fixtures/media/."

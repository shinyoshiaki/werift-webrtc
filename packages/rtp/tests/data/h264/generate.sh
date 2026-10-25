#!/usr/bin/env sh
# Regenerates the H.264 Annex B fixtures used by tests/processor/mp4.realData.test.ts.
# Requires ffmpeg built with libx264 (verified with ffmpeg 6.1.1).
#
# Common properties: testsrc2, 30fps, 0.5s (15 frames), IDR every 5 frames with
# in-band SPS/PPS, no B-frames, and an AUD NAL at the head of every access unit
# so the tests can split the stream into frames.
set -eu
cd "$(dirname "$0")"

gen() {
  name=$1
  size=$2
  shift 2
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "testsrc2=size=${size}:rate=30:duration=0.5" \
    "$@" -an -c:v libx264 -preset veryfast -tune zerolatency -crf 40 \
    -g 5 -keyint_min 5 -sc_threshold 0 -bf 0 -x264-params aud=1 \
    -f h264 "${name}.h264"
}

# Constrained Baseline, 200x150 (height is cropped from 160 in the SPS)
gen baseline_200x150 200x150 -profile:v baseline -pix_fmt yuv420p
# High profile, 320x240 with a 4:3 sample aspect ratio (display 427x240)
gen high_320x240_sar4_3 320x240 -vf setsar=4/3 -profile:v high -pix_fmt yuv420p
# High profile, portrait 180x320 (width is cropped from 192 in the SPS)
gen high_180x320 180x320 -profile:v high -pix_fmt yuv420p

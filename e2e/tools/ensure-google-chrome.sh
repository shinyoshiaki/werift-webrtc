#!/usr/bin/env bash
# Download and extract Google Chrome (H.264-capable) for E2E without root install.
# Output path is printed on stdout; progress goes to stderr.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CACHE="${E2E_CHROME_CACHE:-$ROOT/.cache/google-chrome}"
BIN="$CACHE/opt/google/chrome/google-chrome"

if [[ -x "$BIN" ]]; then
  echo "$BIN"
  exit 0
fi

DEB="${TMPDIR:-/tmp}/google-chrome-stable_current_amd64.deb"
URL="${E2E_CHROME_DEB_URL:-https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb}"

echo "Downloading Google Chrome for H.264 E2E → $CACHE" >&2
mkdir -p "$CACHE"
curl -fsSL -o "$DEB" "$URL"
# Extract data payload only (no dpkg / root required)
tmpdir="$(mktemp -d)"
(
  cd "$tmpdir"
  ar x "$DEB"
  tar -xf data.tar.* -C "$CACHE"
)
rm -rf "$tmpdir"

if [[ ! -x "$BIN" ]]; then
  echo "failed to extract google-chrome at $BIN" >&2
  exit 1
fi

echo "$BIN"

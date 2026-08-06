#!/usr/bin/env bash
# Placeholder install for sysbox image: installs a smoke-check stub when real pion-sped is not built here.
set -euo pipefail
PREFIX="${WERIFT_PREFIX:-/usr/local}"
mkdir -p "${PREFIX}/bin" "${PREFIX}/share"
cat > "${PREFIX}/bin/pion-sped" << 'BIN'
#!/usr/bin/env bash
if [ "${1:-}" = "check" ]; then
  echo "pion-sped check ok (stub)"
  exit 0
fi
echo "pion-sped stub: full agent not bundled in this worktree" >&2
exit 1
BIN
chmod 0755 "${PREFIX}/bin/pion-sped"
echo "stub" > "${PREFIX}/share/werift-pion-sped-pin.txt"
echo "OK: installed pion-sped stub"

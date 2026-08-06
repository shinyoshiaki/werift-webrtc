#!/usr/bin/env bash
set -euo pipefail
PREFIX="${WERIFT_PREFIX:-/usr/local}"
mkdir -p "${PREFIX}/bin" "${PREFIX}/share"
cat > "${PREFIX}/bin/pion-sped-agent" << 'BIN'
#!/usr/bin/env bash
echo "pion-sped-agent stub: full agent not bundled in this worktree" >&2
exit 1
BIN
chmod 0755 "${PREFIX}/bin/pion-sped-agent"
echo "stub" > "${PREFIX}/share/werift-pion-sped-agent-pin.txt"
echo "OK: installed pion-sped-agent stub"

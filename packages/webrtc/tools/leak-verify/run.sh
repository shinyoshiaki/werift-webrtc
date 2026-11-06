#!/usr/bin/env bash
# Evidence for the leak property (tests/pbt/leak/negotiationLeakProperty.test.ts):
#   run.sh repeat [N]   run the leak test file N times (default 10) on the active tree
#   run.sh inject       inject 6 artificial leaks, one at a time, into a temporary
#                       git worktree and require the leak test file (or, for "unit:" entries, the unit test) to fail for each
set -u
ROOT="$(git rev-parse --show-toplevel)"
TEST="tests/pbt/leak/negotiationLeakProperty.test.ts"
LOG="${LEAK_VERIFY_LOG:-/tmp/leak-verify}"
mkdir -p "$LOG"

run_test() { # dir logfile
  (cd "$1/packages/webrtc" && npx vitest run "$TEST" --retry=0 >"$2" 2>&1)
}

repeat() {
  local n="${1:-10}" fail=0
  echo "revision: $(git -C "$ROOT" rev-parse --short HEAD) (uncommitted files: $(git -C "$ROOT" status --porcelain | wc -l))"
  for i in $(seq 1 "$n"); do
    if run_test "$ROOT" "$LOG/repeat-$i.log"; then r=pass; else r=FAIL; fail=$((fail + 1)); fi
    echo "run $i/$n: $r ($(grep -E '^ +Tests ' "$LOG/repeat-$i.log" | tr -s ' '))"
  done
  echo "failed runs: $fail/$n"
  [ "$fail" -eq 0 ]
}

# name|file|node expression replacing a unique string (from, to)
INJECTIONS=(
  "unit:transport-cc records never pruned|packages/webrtc/src/media/sender/senderBWE.ts|const SENT_INFO_MAX_COUNT = 0x8000;|const SENT_INFO_MAX_COUNT = 0x7fffffff;;const SENT_INFO_MAX_AGE_MS = 5000;|const SENT_INFO_MAX_AGE_MS = 1e12;"
  "ICE credential history grows|packages/ice/src/ice.ts|    this.userHistory = {
      ...previous,|    this.userHistory = {
      ...this.userHistory,
      ...previous,"
  "stopped sender subscribes to DTLS|packages/webrtc/src/media/rtpSender.ts|    if (this.stopped) {
      this.dtlsDisposer = [];|    if (false) {
      this.dtlsDisposer = [];"
  "DTLS handshake not closed on stop|packages/webrtc/src/transport/dtls.ts|    // A handshake still in flight stops retransmitting its flight.
    this.dtls?.close();|    // A handshake still in flight stops retransmitting its flight."
  "closed data channel stays listed|packages/webrtc/src/sctpManager.ts|          this.dataChannels.splice(index, 1);|"
  "DTLS flight keeps retransmitting|packages/dtls/src/flight/flight.ts|      if (closed.aborted) return;|;;        { signal: closed },|        {},"
)

inject() {
  local tmp miss=0 spec name file edits
  tmp="$(mktemp -d)/wt"
  git -C "$ROOT" worktree add --detach "$tmp" HEAD >/dev/null
  ln -s "$ROOT/node_modules" "$tmp/node_modules"
  trap 'git -C "$ROOT" worktree remove --force "$tmp" >/dev/null 2>&1' RETURN
  echo "revision: $(git -C "$ROOT" rev-parse --short HEAD) in $tmp"
  for spec in "${INJECTIONS[@]}"; do
    name="${spec%%|*}"; rest="${spec#*|}"; file="${rest%%|*}"; edits="${rest#*|}"
    git -C "$tmp" checkout -q -- .
    if ! node -e '
      const fs=require("fs");const [f,spec]=process.argv.slice(1);
      let s=fs.readFileSync(f,"utf8");
      for (const e of spec.split(";;")) {
        const i=e.indexOf("|");const from=e.slice(0,i),to=e.slice(i+1);
        if (s.split(from).length!==2) { console.error("pattern not unique/missing: "+from); process.exit(1); }
        s=s.replace(from,()=>to);
      }
      fs.writeFileSync(f,s);' "$tmp/$file" "$edits"; then
      echo "[$name] injection did not apply"; miss=$((miss + 1)); continue
    fi
    local target="$TEST"
    # the cycles carry no media, so the transport-cc record is judged by its unit test
    case "$name" in unit:*) target="tests/media/senderBWE.test.ts" ;; esac
    if (cd "$tmp/packages/webrtc" && npx vitest run "$target" --retry=0 >"$LOG/inject-${name//[ :]/_}.log" 2>&1); then
      echo "[$name] NOT detected (test passed)"; miss=$((miss + 1))
    else
      echo "[$name] detected: $(grep -m1 -E 'FAIL|Error' "$LOG/inject-${name//[ :]/_}.log" | cut -c1-140)"
    fi
  done
  echo "undetected or not applied: $miss/${#INJECTIONS[@]}"
  [ "$miss" -eq 0 ]
}

case "${1:-}" in
  repeat) repeat "${2:-10}" ;;
  inject) inject ;;
  *) echo "usage: $0 repeat [N] | inject" >&2; exit 2 ;;
esac

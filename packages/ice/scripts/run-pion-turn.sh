#!/usr/bin/env bash
# Start pion TURN (UDP) on a free host port and print connection env for tests.
# Usage:
#   eval "$(./packages/ice/scripts/run-pion-turn.sh --print-env)"
#   ./packages/ice/scripts/run-pion-turn.sh --up
#   ./packages/ice/scripts/run-pion-turn.sh --down
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_DIR="$(cd "${SCRIPT_DIR}/../docker/pion-turn" && pwd)"
PROJECT_NAME="${PION_TURN_COMPOSE_PROJECT:-werift-pion-turn}"
STATE_DIR="${TMPDIR:-/tmp}/werift-pion-turn-${PROJECT_NAME}"
ENV_FILE="${STATE_DIR}/env"
COMPOSE_FILE="${COMPOSE_DIR}/docker-compose.yml"

USERNAME="${PION_TURN_USERNAME:-username}"
PASSWORD="${PION_TURN_PASSWORD:-password}"
PUBLIC_IP="${PION_TURN_PUBLIC_IP:-127.0.0.1}"
REALM="${PION_TURN_REALM:-localhost}"
USERS="${PION_TURN_USERS:-${USERNAME}=${PASSWORD}}"

MODE="print-env"
DETACH=true

usage() {
  cat <<'EOF'
Usage: run-pion-turn.sh [--print-env|--up|--down|--status] [--foreground]

  --print-env   Start (if needed), wait ready, print export lines (default)
  --up          Start and wait ready (no env print)
  --down        docker compose down and remove state
  --status      Print whether container is running and current env if any
  --foreground  Run compose without -d (blocks; still writes env file)

Environment overrides:
  PION_TURN_PUBLIC_IP, PION_TURN_USERNAME, PION_TURN_PASSWORD,
  PION_TURN_USERS, PION_TURN_REALM, PION_TURN_UDP_PORT (optional fixed port),
  PION_TURN_COMPOSE_PROJECT
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --print-env) MODE="print-env"; shift ;;
    --up) MODE="up"; shift ;;
    --down) MODE="down"; shift ;;
    --status) MODE="status"; shift ;;
    --foreground) DETACH=false; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

compose() {
  docker compose -p "${PROJECT_NAME}" -f "${COMPOSE_FILE}" "$@"
}

pick_free_udp_port() {
  # Prefer python for a true free ephemeral bind.
  if command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY'
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
    return
  fi
  # Fallback: random high port (best-effort).
  echo $((49152 + RANDOM % 10000))
}

write_env_file() {
  local host="$1" port="$2"
  mkdir -p "${STATE_DIR}"
  cat > "${ENV_FILE}" <<EOF
PION_TURN_HOST=${host}
PION_TURN_PORT=${port}
PION_TURN_USERNAME=${USERNAME}
PION_TURN_PASSWORD=${PASSWORD}
PION_TURN_PUBLIC_IP=${PUBLIC_IP}
PION_TURN_REALM=${REALM}
PION_TURN_UDP_PORT=${port}
PION_TURN_COMPOSE_PROJECT=${PROJECT_NAME}
EOF
}

print_exports() {
  if [[ ! -f "${ENV_FILE}" ]]; then
    echo "No env file at ${ENV_FILE}; run --up first" >&2
    return 1
  fi
  # shellcheck disable=SC1090
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
  echo "export PION_TURN_HOST=${PION_TURN_HOST}"
  echo "export PION_TURN_PORT=${PION_TURN_PORT}"
  echo "export PION_TURN_USERNAME=${PION_TURN_USERNAME}"
  echo "export PION_TURN_PASSWORD=${PION_TURN_PASSWORD}"
  echo "export PION_TURN_PUBLIC_IP=${PION_TURN_PUBLIC_IP}"
  echo "export PION_TURN_REALM=${PION_TURN_REALM}"
  echo "export PION_TURN_UDP_PORT=${PION_TURN_UDP_PORT}"
  echo "export PION_TURN_COMPOSE_PROJECT=${PION_TURN_COMPOSE_PROJECT}"
}

wait_ready() {
  local port="$1"
  local host="${PUBLIC_IP}"
  local i
  for i in $(seq 1 60); do
    if command -v python3 >/dev/null 2>&1; then
      if python3 - <<PY
import socket, sys
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.settimeout(0.5)
try:
    # TURN servers answer STUN Binding; even empty may not fail open, so just check UDP port is held by docker/process.
    # Best-effort: try connect + send zero-length; if local routing works, proceed after compose is up.
    s.connect(("${host}", ${port}))
    sys.exit(0)
except Exception:
    sys.exit(1)
finally:
    s.close()
PY
      then
        # Give the server a moment after port is reachable.
        sleep 0.5
        return 0
      fi
    else
      sleep 1
      return 0
    fi
    sleep 0.5
  done
  echo "Timed out waiting for pion TURN on ${host}:${port}" >&2
  return 1
}

do_down() {
  compose down --remove-orphans 2>/dev/null || true
  rm -rf "${STATE_DIR}"
}

do_up() {
  mkdir -p "${STATE_DIR}"
  local port="${PION_TURN_UDP_PORT:-}"
  if [[ -z "${port}" ]]; then
    port="$(pick_free_udp_port)"
  fi

  export PION_TURN_UDP_PORT="${port}"
  export PION_TURN_PUBLIC_IP="${PUBLIC_IP}"
  export PION_TURN_USERS="${USERS}"
  export PION_TURN_REALM="${REALM}"
  export PION_TURN_VERSION="${PION_TURN_VERSION:-main}"

  write_env_file "${PUBLIC_IP}" "${port}"

  # Ensure previous instance for this project is gone (ports/state).
  compose down --remove-orphans 2>/dev/null || true

  if [[ "${DETACH}" == "true" ]]; then
    compose up -d --build
  else
    compose up --build
    return 0
  fi

  wait_ready "${port}"
  echo "pion TURN is up on ${PUBLIC_IP}:${port} (project=${PROJECT_NAME})" >&2
}

case "${MODE}" in
  down)
    do_down
    echo "pion TURN stopped (project=${PROJECT_NAME})" >&2
    ;;
  up)
    do_up
    ;;
  print-env)
    do_up
    print_exports
    ;;
  status)
    if compose ps --status running 2>/dev/null | grep -q pion-turn; then
      echo "running" >&2
      print_exports 2>/dev/null || true
    else
      echo "stopped" >&2
      exit 1
    fi
    ;;
esac

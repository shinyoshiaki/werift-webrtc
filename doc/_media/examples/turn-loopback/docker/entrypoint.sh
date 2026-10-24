#!/usr/bin/env bash
set -euo pipefail

TURN_LOOPBACK_HTTP_PORT="${TURN_LOOPBACK_HTTP_PORT:-8080}"
TURN_LOOPBACK_PUBLIC_PORT="${TURN_LOOPBACK_PUBLIC_PORT:-443}"
CERTBOT_WEBROOT="${CERTBOT_WEBROOT:-/var/www/turn-loopback}"
CERTBOT_STATE_DIR="${CERTBOT_STATE_DIR:-/var/lib/turn-loopback/certbot}"
CERTBOT_RENEW_INTERVAL="${CERTBOT_RENEW_INTERVAL:-0}"
TURN_LOOPBACK_INTERNAL_CERT_DIR="${TURN_LOOPBACK_INTERNAL_CERT_DIR:-/run/turn-loopback/tls}"
export TURN_LOOPBACK_HTTP_PORT
export TURN_LOOPBACK_PUBLIC_PORT
export CERTBOT_WEBROOT
export CERTBOT_STATE_DIR
export CERTBOT_RENEW_INTERVAL
export TURN_LOOPBACK_INTERNAL_CERT_DIR

CERTBOT_CONFIG_DIR="${CERTBOT_STATE_DIR}/config"
CERTBOT_WORK_DIR="${CERTBOT_STATE_DIR}/work"
CERTBOT_LOG_DIR="${CERTBOT_STATE_DIR}/logs"
NGINX_TEMPLATE="/app/examples/turn-loopback/docker/nginx.conf.template"
NGINX_CONFIG="/tmp/turn-loopback-nginx.conf"
TSX_BIN="/app/node_modules/.bin/tsx"

nginx_pid=""
server_pid=""
renew_pid=""

log() {
  printf '[turn-loopback-entrypoint] %s\n' "$*" >&2
}

cleanup() {
  local exit_code="$1"
  trap - EXIT INT TERM

  for pid in "$server_pid" "$nginx_pid" "$renew_pid"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done

  wait "${server_pid:-}" "${nginx_pid:-}" "${renew_pid:-}" 2>/dev/null || true
  exit "$exit_code"
}

trap 'cleanup $?' EXIT
trap 'cleanup 130' INT
trap 'cleanup 143' TERM

prepare_directories() {
  if [[ ! "$CERTBOT_RENEW_INTERVAL" =~ ^[0-9]+$ ]]; then
    log "CERTBOT_RENEW_INTERVAL must be a non-negative integer"
    exit 1
  fi

  mkdir -p \
    "${CERTBOT_WEBROOT}/.well-known/acme-challenge" \
    "$CERTBOT_CONFIG_DIR" \
    "$CERTBOT_WORK_DIR" \
    "$CERTBOT_LOG_DIR" \
    "$TURN_LOOPBACK_INTERNAL_CERT_DIR"
}

authority_has_port() {
  local value="$1"
  if [[ "$value" == \[*\]:* ]]; then
    return 0
  fi

  if [[ "$value" == *:* ]]; then
    local trimmed="${value//:/}"
    if [[ "$trimmed" =~ ^[0-9A-Fa-f]+$ ]]; then
      return 1
    fi
  fi

  [[ "$value" =~ :[0-9]+$ ]]
}

derive_redirect_authority() {
  if [[ -n "${TURN_LOOPBACK_PUBLIC_AUTHORITY:-}" ]]; then
    printf '%s' "${TURN_LOOPBACK_PUBLIC_AUTHORITY}"
    return
  fi

  if [[ -n "${TURN_LOOPBACK_PUBLIC_HOST:-}" ]]; then
    if authority_has_port "${TURN_LOOPBACK_PUBLIC_HOST}"; then
      printf '%s' "${TURN_LOOPBACK_PUBLIC_HOST}"
      return
    fi

    if [[ "${TURN_LOOPBACK_PUBLIC_PORT}" == "443" ]]; then
      printf '%s' "${TURN_LOOPBACK_PUBLIC_HOST}"
      return
    fi

    printf '%s:%s' "${TURN_LOOPBACK_PUBLIC_HOST}" "${TURN_LOOPBACK_PUBLIC_PORT}"
    return
  fi

  printf '%s' '$http_host'
}

render_nginx_config() {
  export TURN_LOOPBACK_REDIRECT_AUTHORITY
  envsubst \
    '${TURN_LOOPBACK_HTTP_PORT} ${CERTBOT_WEBROOT} ${TURN_LOOPBACK_REDIRECT_AUTHORITY}' \
    < "$NGINX_TEMPLATE" \
    > "$NGINX_CONFIG"
}

wait_for_http_app() {
  local attempts=0
  while (( attempts < 50 )); do
    if : >/dev/tcp/127.0.0.1/${TURN_LOOPBACK_HTTP_PORT} 2>/dev/null; then
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 0.2
  done

  log "HTTP challenge app did not start on port ${TURN_LOOPBACK_HTTP_PORT}"
  return 1
}

start_http_app() {
  nginx -c "$NGINX_CONFIG" -g 'daemon off;' &
  nginx_pid="$!"
  wait_for_http_app
  log "started HTTP challenge app on port ${TURN_LOOPBACK_HTTP_PORT}"
}

require_tls_pair() {
  local left_name="$1"
  local right_name="$2"
  local left_value="$3"
  local right_value="$4"

  if [[ -n "$left_value" && -n "$right_value" ]]; then
    return 0
  fi

  if [[ -n "$left_value" || -n "$right_value" ]]; then
    log "${left_name} and ${right_name} must be provided together"
    exit 1
  fi

  return 1
}

export_internal_tls_paths() {
  export TURN_LOOPBACK_CERT_FILE="$1"
  export TURN_LOOPBACK_KEY_FILE="$2"
  log "using TLS files ${TURN_LOOPBACK_CERT_FILE} and ${TURN_LOOPBACK_KEY_FILE}"
}

prepare_self_signed_certificate() {
  local cert_file="${TURN_LOOPBACK_INTERNAL_CERT_DIR}/selfsigned-cert.pem"
  local key_file="${TURN_LOOPBACK_INTERNAL_CERT_DIR}/selfsigned-key.pem"
  local requested_host="${TURN_LOOPBACK_SELF_SIGNED_HOST:-${TURN_LOOPBACK_PUBLIC_HOST:-localhost}}"
  local host_name
  local san_entries=("DNS:localhost" "IP:127.0.0.1")

  host_name="$(normalize_certificate_host "$requested_host")"

  if [[ "$host_name" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    san_entries+=("IP:${host_name}")
  elif [[ "$host_name" != "localhost" && "$host_name" != *:* ]]; then
    san_entries+=("DNS:${host_name}")
  fi

  openssl req \
    -x509 \
    -newkey rsa:2048 \
    -nodes \
    -sha256 \
    -days "${TURN_LOOPBACK_SELF_SIGNED_DAYS:-7}" \
    -subj "/CN=${host_name}" \
    -addext "subjectAltName=$(IFS=,; echo "${san_entries[*]}")" \
    -keyout "$key_file" \
    -out "$cert_file"

  export_internal_tls_paths "$cert_file" "$key_file"
  log "generated self-signed certificate fallback"
}

parse_certbot_domains() {
  local raw_domains="$1"
  local normalized="${raw_domains//,/ }"
  for domain in $normalized; do
    printf '%s\n' "$domain"
  done
}

normalize_certificate_host() {
  local value="$1"

  if [[ "$value" =~ ^\[([^]]+)\]:(.+)$ ]]; then
    value="${BASH_REMATCH[1]}"
  elif authority_has_port "$value"; then
    value="${value%:*}"
  fi

  if [[ "$value" =~ ^\[([^]]+)\]$ ]]; then
    value="${BASH_REMATCH[1]}"
  fi

  printf '%s' "$value"
}

run_certbot_certonly() {
  local email="${CERTBOT_EMAIL:-}"
  local staging="${CERTBOT_STAGING:-0}"
  local first_domain=""
  local -a domains=()
  local -a certbot_args=(
    certonly
    --non-interactive
    --agree-tos
    --webroot
    -w "$CERTBOT_WEBROOT"
    --config-dir "$CERTBOT_CONFIG_DIR"
    --work-dir "$CERTBOT_WORK_DIR"
    --logs-dir "$CERTBOT_LOG_DIR"
    --keep-until-expiring
  )

  while IFS= read -r domain; do
    if [[ -z "$domain" ]]; then
      continue
    fi
    if [[ -z "$first_domain" ]]; then
      first_domain="$domain"
    fi
    domains+=("$domain")
    certbot_args+=(-d "$domain")
  done < <(parse_certbot_domains "${CERTBOT_DOMAINS}")

  if (( ${#domains[@]} == 0 )); then
    log "CERTBOT_DOMAINS must contain at least one domain"
    exit 1
  fi

  CERTBOT_CERT_NAME="$(printf '%s' "$first_domain" | tr -c 'A-Za-z0-9._-' '-')"
  certbot_args+=(--cert-name "$CERTBOT_CERT_NAME")

  if [[ -n "$email" ]]; then
    certbot_args+=(--email "$email")
  else
    certbot_args+=(--register-unsafely-without-email)
  fi

  if [[ "$staging" == "1" || "$staging" == "true" || "$staging" == "yes" ]]; then
    certbot_args+=(--staging)
  fi

  log "requesting ACME certificate for ${domains[*]}"
  certbot "${certbot_args[@]}"
  export_internal_tls_paths \
    "${CERTBOT_CONFIG_DIR}/live/${CERTBOT_CERT_NAME}/fullchain.pem" \
    "${CERTBOT_CONFIG_DIR}/live/${CERTBOT_CERT_NAME}/privkey.pem"
}

start_certbot_renew_loop() {
  if [[ -z "${CERTBOT_DOMAINS:-}" || "${CERTBOT_RENEW_INTERVAL}" == "0" ]]; then
    return
  fi

  (
    set -uo pipefail
    local staging="${CERTBOT_STAGING:-0}"
    local -a renew_args=(
      renew
      --non-interactive
      --webroot
      -w "$CERTBOT_WEBROOT"
      --config-dir "$CERTBOT_CONFIG_DIR"
      --work-dir "$CERTBOT_WORK_DIR"
      --logs-dir "$CERTBOT_LOG_DIR"
    )

    if [[ "$staging" == "1" || "$staging" == "true" || "$staging" == "yes" ]]; then
      renew_args+=(--staging)
    fi

    while true; do
      sleep "$CERTBOT_RENEW_INTERVAL"
      log "running scheduled certbot renew"
      if ! certbot "${renew_args[@]}"; then
        log "scheduled certbot renew failed; keeping existing certificate files"
      fi
    done
  ) &
  renew_pid="$!"
}

prepare_tls_material() {
  if require_tls_pair \
    "TURN_LOOPBACK_CERT_PEM" \
    "TURN_LOOPBACK_KEY_PEM" \
    "${TURN_LOOPBACK_CERT_PEM:-}" \
    "${TURN_LOOPBACK_KEY_PEM:-}"; then
    log "using inline TLS material from environment"
    return
  fi

  if require_tls_pair \
    "TURN_LOOPBACK_CERT_FILE" \
    "TURN_LOOPBACK_KEY_FILE" \
    "${TURN_LOOPBACK_CERT_FILE:-}" \
    "${TURN_LOOPBACK_KEY_FILE:-}"; then
    if [[ ! -f "${TURN_LOOPBACK_CERT_FILE}" || ! -f "${TURN_LOOPBACK_KEY_FILE}" ]]; then
      log "configured TLS files were not found"
      exit 1
    fi
    log "using externally provided TLS files"
    return
  fi

  if [[ -n "${CERTBOT_DOMAINS:-}" ]]; then
    run_certbot_certonly
    start_certbot_renew_loop
    return
  fi

  prepare_self_signed_certificate
}

start_werift_server() {
  if [[ ! -x "$TSX_BIN" ]]; then
    log "tsx binary was not found at ${TSX_BIN}"
    exit 1
  fi

  "$TSX_BIN" --tsconfig tsconfig.server.json server/main.ts &
  server_pid="$!"
  log "started werift HTTPS/TURN server on port ${TURN_LOOPBACK_PORT:-8443}"
}

TURN_LOOPBACK_REDIRECT_AUTHORITY="$(derive_redirect_authority)"

prepare_directories
render_nginx_config
start_http_app
prepare_tls_material
start_werift_server

set +e
wait -n "$nginx_pid" "$server_pid"
exit_code="$?"
set -e

log "primary process exited with status ${exit_code}"
cleanup "$exit_code"

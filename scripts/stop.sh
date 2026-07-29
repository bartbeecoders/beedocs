#!/usr/bin/env bash
# Stop local BeeDocs processes bound to the default (or override) ports.
set -euo pipefail

API_PORT="${API_PORT:-5080}"
WEB_PORT="${WEB_PORT:-5173}"
MCP_PORT="${MCP_PORT:-5090}"

log() { printf '🐝 %s\n' "$*"; }

stop_port() {
  local port="$1"
  local pids=""
  if command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  fi
  if [[ -z "$pids" ]]; then
    log "Nothing listening on :$port"
    return 0
  fi
  log "Stopping process(es) on :$port → $pids"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  sleep 0.3
  # shellcheck disable=SC2086
  kill -9 $pids 2>/dev/null || true
}

stop_port "$API_PORT"
stop_port "$WEB_PORT"
stop_port "$MCP_PORT"
log "Done."

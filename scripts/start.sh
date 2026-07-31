#!/usr/bin/env bash
# BeeDocs local dev: API (:5080) + web (:5173) + MCP over HTTP (:5090).
#
# Set SKIP_MCP=1 to run just the API and web. Agents using the stdio MCP
# transport do not need this process — it is only the HTTP transport.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_DIR="$ROOT/src/BeeDocs.Api"
WEB_DIR="$ROOT/src/beedocs-web"
MCP_DIR="$ROOT/src/BeeDocs.Mcp"
LOG_DIR="$ROOT/scripts/.logs"
API_PORT="${API_PORT:-5080}"
WEB_PORT="${WEB_PORT:-5200}"
MCP_PORT="${MCP_PORT:-5090}"
API_URL="http://localhost:${API_PORT}"
WEB_URL="http://localhost:${WEB_PORT}"
MCP_URL="http://localhost:${MCP_PORT}"
# Local-only shared secret. The deployed server gets a random one from the
# cluster secret instead — see Docs/MCP-HOSTING.md.
MCP_AUTH_TOKEN="${MCP_AUTH_TOKEN:-dev-token}"
SKIP_MCP="${SKIP_MCP:-0}"

API_PID=""
WEB_PID=""
MCP_PID=""

mkdir -p "$LOG_DIR"

log() { printf '🐝 %s\n' "$*"; }
err() { printf '❌ %s\n' "$*" >&2; }

cleanup() {
  local code=$?
  trap - EXIT INT TERM
  log "Stopping BeeDocs…"
  if [[ -n "${MCP_PID}" ]] && kill -0 "$MCP_PID" 2>/dev/null; then
    kill "$MCP_PID" 2>/dev/null || true
    wait "$MCP_PID" 2>/dev/null || true
  fi
  if [[ -n "${WEB_PID}" ]] && kill -0 "$WEB_PID" 2>/dev/null; then
    kill "$WEB_PID" 2>/dev/null || true
    wait "$WEB_PID" 2>/dev/null || true
  fi
  if [[ -n "${API_PID}" ]] && kill -0 "$API_PID" 2>/dev/null; then
    kill "$API_PID" 2>/dev/null || true
    wait "$API_PID" 2>/dev/null || true
  fi
  # Anything still bound to our ports
  if command -v lsof >/dev/null 2>&1; then
    for port in "$API_PORT" "$WEB_PORT" "$MCP_PORT"; do
      local pids
      pids="$(lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
      if [[ -n "$pids" ]]; then
        # shellcheck disable=SC2086
        kill $pids 2>/dev/null || true
      fi
    done
  fi
  log "Stopped."
  exit "$code"
}
trap cleanup EXIT INT TERM

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "Missing required command: $1"
    exit 1
  fi
}

setup_node() {
  # Prefer Node 22+ for pnpm/Vite. Prefer PATH pin over `nvm use` (avoids .npmrc prefix noise).
  local node_bin=""
  if [[ -d "${NVM_DIR:-$HOME/.nvm}/versions/node" ]]; then
    local latest22
    latest22="$(ls -1d "${NVM_DIR:-$HOME/.nvm}/versions/node"/v22.* 2>/dev/null | sort -V | tail -1 || true)"
    if [[ -n "$latest22" && -x "$latest22/bin/node" ]]; then
      export PATH="$latest22/bin:$PATH"
      node_bin="$latest22/bin/node"
    fi
  fi

  if [[ -z "$node_bin" ]] && ! command -v node >/dev/null 2>&1; then
    err "Node.js not found. Install Node 22+ (or nvm with v22)."
    exit 1
  fi

  require_cmd node
  local major
  major="$(node -p "process.versions.node.split('.')[0]")"
  if [[ "$major" -lt 20 ]]; then
    err "Node.js 20+ required (found $(node -v)). Install Node 22 for best results."
    exit 1
  fi
  log "Using Node $(node -v)"

  # Prefer pnpm 9.x with Node 20/22 (global pnpm 10+ may require Node 22+ sqlite).
  if command -v corepack >/dev/null 2>&1; then
    corepack enable >/dev/null 2>&1 || true
    corepack prepare pnpm@9.15.9 --activate >/dev/null 2>&1 || true
  fi

  if command -v pnpm >/dev/null 2>&1; then
    PNPM=(pnpm)
  else
    PNPM=(npx --yes pnpm@9.15.9)
  fi
}

port_in_use() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v ss >/dev/null 2>&1; then
    ss -ltn "sport = :$port" 2>/dev/null | grep -q ":$port"
  else
    return 1
  fi
}

# Stop anything already bound to API/web ports so start is always a clean restart.
stop_existing() {
  log "Stopping any services already running on :$API_PORT / :$WEB_PORT / :$MCP_PORT …"
  if [[ -x "$ROOT/scripts/stop.sh" ]]; then
    API_PORT="$API_PORT" WEB_PORT="$WEB_PORT" MCP_PORT="$MCP_PORT" "$ROOT/scripts/stop.sh" || true
  else
    for port in "$API_PORT" "$WEB_PORT" "$MCP_PORT"; do
      local pids=""
      if command -v lsof >/dev/null 2>&1; then
        pids="$(lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
      fi
      if [[ -n "$pids" ]]; then
        log "Stopping process(es) on :$port → $pids"
        # shellcheck disable=SC2086
        kill $pids 2>/dev/null || true
        sleep 0.3
        # shellcheck disable=SC2086
        kill -9 $pids 2>/dev/null || true
      fi
    done
  fi

  local i
  for ((i = 1; i <= 20; i++)); do
    if ! port_in_use "$API_PORT" && ! port_in_use "$WEB_PORT" && ! port_in_use "$MCP_PORT"; then
      log "Ports are free."
      return 0
    fi
    sleep 0.15
  done

  if port_in_use "$API_PORT" || port_in_use "$WEB_PORT" || port_in_use "$MCP_PORT"; then
    err "Could not free API/web/MCP ports. Check: lsof -iTCP:$API_PORT -sTCP:LISTEN"
    exit 1
  fi
}

wait_http() {
  local url="$1"
  local name="$2"
  local tries="${3:-60}"
  local i
  for ((i = 1; i <= tries; i++)); do
    if curl -sf "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  err "$name did not become ready at $url"
  return 1
}

main() {
  require_cmd dotnet
  require_cmd curl
  setup_node

  stop_existing

  if [[ ! -d "$WEB_DIR/node_modules" ]]; then
    log "Installing web dependencies…"
    (cd "$WEB_DIR" && "${PNPM[@]}" install)
  fi

  log "Starting API on $API_URL …"
  (
    cd "$API_DIR"
    export ASPNETCORE_ENVIRONMENT="${ASPNETCORE_ENVIRONMENT:-Development}"
    export ASPNETCORE_URLS="http://localhost:${API_PORT}"
    exec dotnet run --no-launch-profile
  ) >"$LOG_DIR/api.log" 2>&1 &
  API_PID=$!

  wait_http "$API_URL/api/health" "API"

  log "Starting web on $WEB_URL …"
  (
    cd "$WEB_DIR"
    exec "${PNPM[@]}" exec vite --host 127.0.0.1 --port "$WEB_PORT"
  ) >"$LOG_DIR/web.log" 2>&1 &
  WEB_PID=$!

  # Vite is up when the port answers or index is reachable
  for ((i = 1; i <= 60; i++)); do
    if curl -sf "$WEB_URL" >/dev/null 2>&1; then
      break
    fi
    if ! kill -0 "$WEB_PID" 2>/dev/null; then
      err "Web process exited early. See $LOG_DIR/web.log"
      tail -n 40 "$LOG_DIR/web.log" >&2 || true
      exit 1
    fi
    sleep 0.25
  done

  local tail_logs=("$LOG_DIR/api.log" "$LOG_DIR/web.log")

  if [[ "$SKIP_MCP" != "1" ]]; then
    log "Starting MCP (http) on $MCP_URL/mcp …"
    (
      cd "$MCP_DIR"
      export MCP_TRANSPORT=http
      export MCP_HTTP_PORT="$MCP_PORT"
      export MCP_AUTH_TOKEN="$MCP_AUTH_TOKEN"
      export BEEDOCS_API_URL="$API_URL"
      exec dotnet run --no-launch-profile
    ) >"$LOG_DIR/mcp.log" 2>&1 &
    MCP_PID=$!

    if ! wait_http "$MCP_URL/healthz" "MCP" 40; then
      tail -n 40 "$LOG_DIR/mcp.log" >&2 || true
      exit 1
    fi
    tail_logs+=("$LOG_DIR/mcp.log")
  fi

  log "BeeDocs is ready"
  log "  UI:  $WEB_URL"
  log "  API: $API_URL  (health: $API_URL/api/health)"
  if [[ "$SKIP_MCP" != "1" ]]; then
    log "  MCP: $MCP_URL/mcp  (bearer: $MCP_AUTH_TOKEN)"
    log "       claude mcp add --transport http beedocs-local $MCP_URL/mcp -H \"Authorization: Bearer $MCP_AUTH_TOKEN\""
  fi
  log "  Logs: ${tail_logs[*]}"
  log "Press Ctrl+C to stop everything."

  # Stream logs while processes run
  tail -n 0 -F "${tail_logs[@]}" &
  local tail_pid=$!

  while kill -0 "$API_PID" 2>/dev/null && kill -0 "$WEB_PID" 2>/dev/null \
    && { [[ "$SKIP_MCP" == "1" ]] || kill -0 "$MCP_PID" 2>/dev/null; }; do
    sleep 1
  done

  kill "$tail_pid" 2>/dev/null || true

  if ! kill -0 "$API_PID" 2>/dev/null; then
    err "API exited unexpectedly. Last log lines:"
    tail -n 40 "$LOG_DIR/api.log" >&2 || true
    exit 1
  fi
  if ! kill -0 "$WEB_PID" 2>/dev/null; then
    err "Web exited unexpectedly. Last log lines:"
    tail -n 40 "$LOG_DIR/web.log" >&2 || true
    exit 1
  fi
  if [[ "$SKIP_MCP" != "1" ]] && ! kill -0 "$MCP_PID" 2>/dev/null; then
    err "MCP exited unexpectedly. Last log lines:"
    tail -n 40 "$LOG_DIR/mcp.log" >&2 || true
    exit 1
  fi
}

main "$@"

#!/bin/bash
set -euo pipefail

#===============================================================================
# beedocshome — local dev server
#
# The site is plain static HTML/CSS/JS with no build step, so "start" just
# serves the folder.
#
# Usage:
#   ./scripts/start.sh              # python http.server on :5300
#   ./scripts/start.sh container    # build the real nginx image and run it
#   PORT=8000 ./scripts/start.sh    # pick another port
#===============================================================================

SITE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-5300}"
MODE="${1:-serve}"

# Free the port so a re-run is always a clean restart (same convention as the
# main repo's start.sh).
if command -v fuser >/dev/null 2>&1; then
  fuser -k "$PORT/tcp" 2>/dev/null || true
fi

case "$MODE" in
  serve)
    command -v python3 >/dev/null 2>&1 || { echo "python3 not found"; exit 1; }
    echo "==> Serving beedocshome at http://localhost:$PORT"
    exec python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$SITE_DIR"
    ;;
  container)
    RUNTIME="$(command -v podman || command -v docker || true)"
    [[ -n "$RUNTIME" ]] || { echo "podman or docker required"; exit 1; }
    echo "==> Building and running the nginx image at http://localhost:$PORT"
    "$RUNTIME" build -t beedocshome:dev "$SITE_DIR"
    exec "$RUNTIME" run --rm -p "$PORT:8080" --name beedocshome-dev beedocshome:dev
    ;;
  *)
    echo "Unknown mode: $MODE"
    echo "Usage: $0 [serve|container]"
    exit 1
    ;;
esac

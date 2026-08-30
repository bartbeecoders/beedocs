#!/usr/bin/env bash
# Build BeeDocs for production and install it on this (Omarchy/Linux) machine
# as a systemd *user* service, then point the Omarchy bar plugin at it.
#
# Mirrors the Dockerfile: publish the API, build the web app, drop dist/ into
# the API's wwwroot so ONE process serves UI + API + uploads.
#
#   ./scripts/install-omarchy.sh              # build + (re)install + bind plugin
#   BEEDOCS_PORT=5088 ./scripts/install-omarchy.sh
#   WITH_MCP=0 ./scripts/install-omarchy.sh   # skip the MCP HTTP service
#
# Layout under $PREFIX (default ~/.local/share/beedocs):
#   app/    published API + wwwroot — REPLACED on every install
#   mcp/    published MCP server    — REPLACED on every install (WITH_MCP=1)
#   data/   sqlite / uploads / attachments — NEVER touched after first install
#
# First install only: if the dev checkout has a database, it is copied in
# (sqlite3 .backup, safe against a live WAL db) so the standalone instance
# starts with your library instead of an empty setup screen.

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
PREFIX=${BEEDOCS_PREFIX:-"$HOME/.local/share/beedocs"}
PORT=${BEEDOCS_PORT:-5088}
WITH_MCP=${WITH_MCP:-1}
MCP_PORT=${MCP_PORT:-5098}
UNIT_DIR="$HOME/.config/systemd/user"
SHELL_JSON="$HOME/.config/omarchy/shell.json"

DOTNET=$(command -v dotnet) || { echo "dotnet not found on PATH" >&2; exit 1; }
command -v pnpm >/dev/null || { echo "pnpm not found on PATH" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq not found on PATH" >&2; exit 1; }

echo "==> Building web UI (pnpm build)"
( cd "$REPO_ROOT/src/beedocs-web" && pnpm install --frozen-lockfile && pnpm build )

echo "==> Publishing BeeDocs.Api (Release)"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
"$DOTNET" publish "$REPO_ROOT/src/BeeDocs.Api/BeeDocs.Api.csproj" \
  -c Release -o "$STAGE/app" /p:UseAppHost=false --nologo
cp -r "$REPO_ROOT/src/beedocs-web/dist" "$STAGE/app/wwwroot"
# The install must never inherit the dev checkout's database.
rm -rf "$STAGE/app/data"

if [[ $WITH_MCP == 1 ]]; then
  echo "==> Publishing BeeDocs.Mcp (Release)"
  # After pnpm build so the freshly generated diagram catalog gets embedded.
  "$DOTNET" publish "$REPO_ROOT/src/BeeDocs.Mcp/BeeDocs.Mcp.csproj" \
    -c Release -o "$STAGE/mcp" /p:UseAppHost=false --nologo
fi

echo "==> Installing to $PREFIX"
mkdir -p "$PREFIX/data/sqlite" "$PREFIX/data/uploads" "$PREFIX/data/attachments"

DEV_DB="$REPO_ROOT/src/BeeDocs.Api/data/sqlite/beedocs.db"
NEW_DB="$PREFIX/data/sqlite/beedocs.db"
if [[ ! -e $NEW_DB && -e $DEV_DB ]]; then
  echo "==> First install: seeding data from the dev checkout"
  if command -v sqlite3 >/dev/null; then
    sqlite3 "$DEV_DB" ".backup '$NEW_DB'"
  else
    cp "$DEV_DB" "$NEW_DB"
  fi
  for d in uploads attachments; do
    if [[ -d "$REPO_ROOT/src/BeeDocs.Api/data/$d" ]]; then
      cp -rn "$REPO_ROOT/src/BeeDocs.Api/data/$d/." "$PREFIX/data/$d/" 2>/dev/null || true
    fi
  done
fi

systemctl --user stop beedocs.service 2>/dev/null || true
systemctl --user stop beedocs-mcp.service 2>/dev/null || true
rm -rf "$PREFIX/app"
mv "$STAGE/app" "$PREFIX/app"
if [[ $WITH_MCP == 1 ]]; then
  rm -rf "$PREFIX/mcp"
  mv "$STAGE/mcp" "$PREFIX/mcp"
fi

echo "==> Writing systemd user units"
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/beedocs.service" <<UNIT
[Unit]
Description=BeeDocs documentation platform (API + UI)

[Service]
WorkingDirectory=$PREFIX/app
ExecStart=$DOTNET $PREFIX/app/BeeDocs.Api.dll
Environment=ASPNETCORE_URLS=http://localhost:$PORT
Environment=BeeDocs__DataPath=$PREFIX/data/sqlite
Environment=BeeDocs__UploadsPath=$PREFIX/data/uploads
Environment=BeeDocs__AttachmentsPath=$PREFIX/data/attachments
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
UNIT

if [[ $WITH_MCP == 1 ]]; then
  cat > "$UNIT_DIR/beedocs-mcp.service" <<UNIT
[Unit]
Description=BeeDocs MCP server (Streamable HTTP)
After=beedocs.service
Wants=beedocs.service

[Service]
WorkingDirectory=$PREFIX/mcp
ExecStart=$DOTNET $PREFIX/mcp/BeeDocs.Mcp.dll
Environment=MCP_TRANSPORT=http
Environment=MCP_HTTP_PORT=$MCP_PORT
Environment=BEEDOCS_API_URL=http://localhost:$PORT
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
UNIT
fi

systemctl --user daemon-reload
systemctl --user enable --now beedocs.service
if [[ $WITH_MCP == 1 ]]; then
  systemctl --user enable --now beedocs-mcp.service
fi

echo "==> Waiting for http://localhost:$PORT/api/health"
for _ in $(seq 1 30); do
  if HEALTH=$(curl -fsS --max-time 2 "http://localhost:$PORT/api/health" 2>/dev/null); then
    echo "    $HEALTH"
    break
  fi
  sleep 1
done
[[ -n ${HEALTH:-} ]] || { echo "Server did not come up; see: journalctl --user -u beedocs" >&2; exit 1; }

if [[ -f $SHELL_JSON ]] && jq -e '.bar.layout[]?[]? | select(.id == "bart.beedocs")' "$SHELL_JSON" >/dev/null 2>&1; then
  echo "==> Binding the Omarchy plugin to http://localhost:$PORT"
  cp "$SHELL_JSON" "$SHELL_JSON.bak.$(date +%s)"
  jq --arg url "http://localhost:$PORT" '
    .bar.layout |= map_values(map(
      if type == "object" and .id == "bart.beedocs" then
        .baseUrl = $url | .webUrl = "" | .startCommand = "systemctl --user start beedocs"
      else . end
    ))' "$SHELL_JSON" > "$SHELL_JSON.tmp" && mv "$SHELL_JSON.tmp" "$SHELL_JSON"
else
  echo "==> Omarchy plugin not found in $SHELL_JSON — skipping bind"
  echo "    (ln -s $REPO_ROOT/omarchy-plugin ~/.config/omarchy/plugins/bart.beedocs && omarchy plugin enable bart.beedocs)"
fi

echo
echo "BeeDocs installed."
echo "  UI + API   http://localhost:$PORT"
[[ $WITH_MCP == 1 ]] && echo "  MCP (http) http://localhost:$MCP_PORT/mcp  (healthz on /healthz)"
echo "  Data       $PREFIX/data"
echo "  Service    systemctl --user status|restart beedocs"
[[ $WITH_MCP == 1 ]] && echo "             systemctl --user status|restart beedocs-mcp"
echo "  Logs       journalctl --user -u beedocs -f"
echo
echo "Re-run this script after pulling changes to redeploy (data is preserved)."
if [[ $WITH_MCP == 1 ]]; then
  echo "Note: if sign-in is enabled on this instance, set BeeDocs__ApiKey in"
  echo "beedocs.service and BEEDOCS_API_KEY in beedocs-mcp.service, then"
  echo "'systemctl --user daemon-reload && systemctl --user restart beedocs beedocs-mcp'."
fi

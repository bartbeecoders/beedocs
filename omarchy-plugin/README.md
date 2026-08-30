# BeeDocs Omarchy plugin

An [Omarchy](https://omarchy.org/) shell bar widget for BeeDocs: a hexagon pill
in the bar that watches the server, a popup panel with full-text search over
the library, and one-click launching of the workspace as its own window.

```
Bar pill    server up/down at a glance (badge when unreachable)
Panel       status + library counts · type-to-search (/api/search) ·
            Enter/click opens the hit · Start button when the server is down
Window      the BeeDocs workspace as a chromium app-mode window
            (omarchy-launch-or-focus-webapp)
```

The workspace is **not** embedded in the panel on purpose: QtWebEngine cannot
initialize inside Quickshell (Chromium's command-line bootstrap crashes the
shell process), so the panel is native QML and the workspace opens as a real
window — which is also nicer to tile, float, or pin with Hyprland rules.

## Install

```bash
ln -s /path/to/BeeDocs/omarchy-plugin ~/.config/omarchy/plugins/bart.beedocs
omarchy plugin enable bart.beedocs
```

To also install BeeDocs itself as a local systemd user service (production
build, one process serving UI + API on :5088, optional MCP on :5098) and bind
this widget to it in one go:

```bash
./scripts/install-omarchy.sh          # from the BeeDocs checkout
```

Note: edits under a symlinked plugin directory on another filesystem may not
hot-reload; run `omarchy restart shell` after changing the QML.

## Interactions

| Where | Action | Result |
|-------|--------|--------|
| Bar pill | left-click | open/focus the workspace window |
| Bar pill | right-click | toggle the search panel |
| Bar pill | middle-click | re-check the server |
| Panel | type | search the library (debounced, top 8 hits) |
| Panel | ↑/↓ + Enter, or click | open the hit in a workspace window |
| Panel | Esc | close |
| Panel (offline) | `s` / Start button | run `scripts/start.sh` in a terminal |

Keybindings (in `~/.config/hypr/bindings.lua`):

```lua
-- Workspace window (same as left-clicking the pill)
o.bind("SUPER + SHIFT + D", "BeeDocs", "omarchy-shell bart.beedocs app")
-- Search panel
o.bind("SUPER + SHIFT + F", "BeeDocs search", "omarchy-shell shell toggle bart.beedocs")
```

## Settings

Configured per-widget in the shell settings UI, or inline in
`~/.config/omarchy/shell.json` on the `bart.beedocs` bar entry:

| Key | Default | Meaning |
|-----|---------|---------|
| `baseUrl` | `http://localhost:5080` | Where the BeeDocs **API** answers (`/api/health`, `/api/search`). |
| `webUrl` | *(empty = baseUrl)* | Where **windows** open. In production one origin serves API + UI, so leave it empty. The dev stack (`scripts/start.sh`) serves the UI from Vite on `http://localhost:5200`, which proxies `/api` back — set that here. |
| `apiKey` | *(empty)* | Sent as `X-Api-Key`. Needed for search when the instance has sign-in enabled (`BeeDocs:Auth:Enabled`) — set `BeeDocs:ApiKey` on the server and mirror it here. Health stays anonymous, so status works either way. |
| `refreshIntervalSec` | `30` | Health-poll cadence. |
| `projectDir` | *(empty)* | A BeeDocs checkout. When set and the server is down, the panel offers **Start BeeDocs** (runs `scripts/start.sh` in a terminal). |
| `startCommand` | *(empty)* | Command that starts the server when it is down — `scripts/install-omarchy.sh` sets it to `systemctl --user start beedocs`. Takes precedence over `projectDir`. |
| `windowPattern` | `chrome-localhost__-Default` | Class/title regex `omarchy-launch-or-focus-webapp` uses to focus an existing workspace window. Chromium derives the class from the URL host (`chrome-<host>__-Default`) — adjust for a remote instance. |

A Cloudflare-Access-protected instance (see `Docs/MCP-HOSTING.md`) won't work
for panel search — the XHR can't do interactive SSO. Point the widget at a
local or directly reachable instance.

## Window placement

Deep links from search open their own app-mode window per document; the bar's
middle-click window is focused-or-launched via `windowPattern`. To float the
workspace like a scratchpad, add a Hyprland rule for the class, e.g. in
`~/.config/hypr/windows.lua`: match `chrome-localhost__-Default` and set
float + size to taste.

## Files

```
manifest.json    Omarchy plugin manifest (bar-widget, settings schema)
Panel.qml        bar pill + popup panel (search UI, keyboard model)
Service.qml      API client (XHR), launchers, start action
BeeDocsIcon.qml  hexagon-with-text-lines mark, urgent badge when offline
```

Search snippets highlight matched terms via the API's U+E000/U+E001 markers;
counts come from `/api/search/status`; hit rows use the `url` the API already
returns for every hit, so the panel needs no route knowledge of its own.

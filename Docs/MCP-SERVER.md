# Connecting AI agents to BeeDocs (MCP)

BeeDocs ships an **MCP (Model Context Protocol) server** that exposes the full REST API to AI agents: books, chapters, pages (Markdown), and diagrams (BeeDiagram / Mermaid / C4).

Agents run the MCP process over **stdio**. The process then calls your local (or remote) BeeDocs HTTP API.

```
┌─────────────┐  stdio (JSON-RPC)  ┌──────────────┐  HTTP  ┌─────────────┐
│ AI client   │ ◄───────────────► │ beedocs-mcp  │ ─────► │ BeeDocs.Api │
│ Cursor/etc. │                   │  (Node.js)    │        │ :5080       │
└─────────────┘                   └──────────────┘        └─────────────┘
```

## Prerequisites

1. **Node.js 20+** (22 recommended)
2. **BeeDocs API running** (default `http://localhost:5080`)

```bash
# from repo root
./scripts/start.sh
# or API only:
cd src/BeeDocs.Api && dotnet run
```

3. **MCP package installed & built**

```bash
cd src/beedocs-mcp
# Node 22 if you use nvm:
# export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
pnpm install
pnpm build
```

Verify the API:

```bash
curl -s http://localhost:5080/api/health
# {"status":"ok","service":"BeeDocs.Api"}
```

## Environment variables

| Variable | Default | Meaning |
|----------|---------|---------|
| `BEEDOCS_API_URL` | `http://localhost:5080` | Base URL of BeeDocs API (no trailing slash required) |
| `BEEDOCS_URL` | (fallback) | Same as `BEEDOCS_API_URL` if set |

## Run manually (debug)

```bash
cd src/beedocs-mcp
export BEEDOCS_API_URL=http://localhost:5080
pnpm start
# Server waits on stdin; status goes to stderr:
# [beedocs-mcp] connected (API http://localhost:5080)
```

For TypeScript without build:

```bash
pnpm dev
```

---

## Client configuration

Use an **absolute path** to this repo (examples below use `REPO` as a placeholder).

```bash
# resolve once
export REPO="/run/media/bart/Development/dev/bartbeecoders/BeeDocs"
export NODE="$(command -v node)"   # prefer Node 22+
```

### Grok (this CLI / TUI)

BeeDocs is registered as an MCP server for Grok in two places:

1. **Project:** `.grok/config.toml` (in this repo)
2. **User:** `~/.grok/config.toml` under `[mcp_servers.beedocs]`

```toml
[mcp_servers.beedocs]
command = "/home/bart/.nvm/versions/node/v22.22.2/bin/node"
args = [
  "/run/media/bart/Development/dev/bartbeecoders/BeeDocs/src/beedocs-mcp/dist/index.js",
]
enabled = true

[mcp_servers.beedocs.env]
BEEDOCS_API_URL = "http://localhost:5080"
```

After editing, restart the Grok session (or wait for config hot-reload) so tools appear as `beedocs__…` via the MCP bridge.

CLI check:

```bash
grok mcp list
grok mcp doctor beedocs
```

Ensure the BeeDocs API is running (`./scripts/start.sh`) before calling tools.

### Cursor

Create or edit **`.cursor/mcp.json`** in the project (or global Cursor MCP settings):

```json
{
  "mcpServers": {
    "beedocs": {
      "command": "node",
      "args": [
        "/ABSOLUTE/PATH/TO/BeeDocs/src/beedocs-mcp/dist/index.js"
      ],
      "env": {
        "BEEDOCS_API_URL": "http://localhost:5080"
      }
    }
  }
}
```

With `pnpm` + `tsx` (no build step):

```json
{
  "mcpServers": {
    "beedocs": {
      "command": "pnpm",
      "args": [
        "--dir",
        "/ABSOLUTE/PATH/TO/BeeDocs/src/beedocs-mcp",
        "exec",
        "tsx",
        "src/index.ts"
      ],
      "env": {
        "BEEDOCS_API_URL": "http://localhost:5080"
      }
    }
  }
}
```

Reload MCP servers in Cursor. You should see tools prefixed with `beedocs_`.

### Claude Desktop

Edit the Claude Desktop config file:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "beedocs": {
      "command": "node",
      "args": [
        "/ABSOLUTE/PATH/TO/BeeDocs/src/beedocs-mcp/dist/index.js"
      ],
      "env": {
        "BEEDOCS_API_URL": "http://localhost:5080"
      }
    }
  }
}
```

Restart Claude Desktop after saving.

### Claude Code / Claude CLI

Add an MCP server (project or user scope):

```bash
claude mcp add beedocs --env BEEDOCS_API_URL=http://localhost:5080 -- \
  node /ABSOLUTE/PATH/TO/BeeDocs/src/beedocs-mcp/dist/index.js
```

Or add to `.mcp.json` in the project root:

```json
{
  "mcpServers": {
    "beedocs": {
      "command": "node",
      "args": ["src/beedocs-mcp/dist/index.js"],
      "env": {
        "BEEDOCS_API_URL": "http://localhost:5080"
      }
    }
  }
}
```

(Paths relative to the project root work when Claude Code is started from that root.)

### VS Code (GitHub Copilot / MCP)

In `.vscode/mcp.json` (or user MCP settings):

```json
{
  "servers": {
    "beedocs": {
      "type": "stdio",
      "command": "node",
      "args": [
        "${workspaceFolder}/src/beedocs-mcp/dist/index.js"
      ],
      "env": {
        "BEEDOCS_API_URL": "http://localhost:5080"
      }
    }
  }
}
```

### Continue / other stdio clients

Any client that can spawn:

```text
command: node
args:    [<repo>/src/beedocs-mcp/dist/index.js]
env:     BEEDOCS_API_URL=http://localhost:5080
```

---

## Agent workflow (example)

1. `beedocs_health` — confirm API is up  
2. `beedocs_list_books` — see existing shelves  
3. `beedocs_create_book` — e.g. title `"Payment Platform"`  
4. `beedocs_create_page` — Markdown architecture notes  
5. `beedocs_create_beediagram_with_nodes` — structured diagram  
6. `beedocs_embed_diagram_in_page` — inject `beediagram-ref` into the page  
7. Open the UI at `http://localhost:5173` to review  

Prompts available to clients that support MCP prompts:

- `beedocs_document_system`
- `beedocs_add_architecture_diagram`
- `beedocs_write_runbook_page`

See [MCP-TOOLS.md](./MCP-TOOLS.md) for the full catalog.

## Resources (read-only URIs)

| URI | Content |
|-----|---------|
| `beedocs://library` | All books (JSON) |
| `beedocs://books/{bookId}` | One book |
| `beedocs://books/{bookId}/pages` | Page list |
| `beedocs://pages/{pageId}` | Full page + Markdown |
| `beedocs://diagrams/{diagramId}` | Full diagram + source |

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Tools fail with connection errors | Start API: `./scripts/start.sh` or `dotnet run` in `src/BeeDocs.Api` |
| `ENOENT` on `dist/index.js` | Run `pnpm build` in `src/beedocs-mcp` |
| Wrong Node version / pnpm sqlite errors | Use Node 20+ or 22; `export PATH` to nvm Node 22 |
| Empty tool list in client | Rebuild MCP package; restart the MCP host app |
| CORS / browser issues | MCP does not use the browser; only the API URL matters |
| Remote API | Set `BEEDOCS_API_URL=https://your-host:8080` in the MCP `env` block |

### Logs

- **stdout** is reserved for MCP protocol — do not pipe application logs there.  
- Startup line is on **stderr**: `[beedocs-mcp] connected (API …)`.

## Security notes

- The MCP server currently has **the same access as unauthenticated API** (MVP has no auth).  
- Only enable it for trusted local agents or behind a secured API later.  
- Destructive tools (`beedocs_delete_*`) permanently remove data.

## Package layout

```
src/beedocs-mcp/
  package.json
  tsconfig.json
  src/
    index.ts      # entry (stdio)
    client.ts     # HTTP → BeeDocs.Api
    tools.ts      # all MCP tools
    resources.ts  # MCP resources
    prompts.ts    # MCP prompts
  dist/           # build output (git-ignored if you prefer)
```

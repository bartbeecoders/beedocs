# Connecting AI agents to BeeDocs (MCP)

BeeDocs ships an **MCP (Model Context Protocol) server** that exposes the full REST API to AI agents: books, chapters, pages (Markdown), and diagrams (BeeDiagram / Mermaid / C4).

There are **two ways to connect**, and they expose exactly the same tools,
resources, and prompts.

### 1. HTTP — point at a URL (recommended)

Nothing to install. The server runs as a process you connect *to*, either the
hosted K3S instance or the one `./scripts/start.sh` starts on `:5090`.

```
┌─────────────┐   Streamable HTTP   ┌──────────────┐  HTTP  ┌─────────────┐
│ AI client   │ ◄─────────────────► │ beedocs-mcp  │ ─────► │ BeeDocs.Api │
│ Cursor/etc. │      POST /mcp      │  (Node.js)   │        │             │
└─────────────┘                     └──────────────┘        └─────────────┘
                                     hosted, or :5090 locally
```

### 2. stdio — the client spawns it

The classic setup: your client launches `node dist/index.js` as a subprocess and
talks JSON-RPC over stdin/stdout. Requires a clone, `pnpm install`, and
`pnpm build` on every machine.

```
┌─────────────┐  stdio (JSON-RPC)  ┌──────────────┐  HTTP  ┌─────────────┐
│ AI client   │ ◄───────────────► │ beedocs-mcp  │ ─────► │ BeeDocs.Api │
│ Cursor/etc. │                   │  (Node.js)   │        │ :5080       │
└─────────────┘                   └──────────────┘        └─────────────┘
```

### Which one?

| | HTTP | stdio |
|---|---|---|
| Install per machine | none | clone + `pnpm install` + `pnpm build` |
| Shared team instance | ✅ one URL for everyone | ❌ each person runs their own |
| Works offline | only against a local server | ✅ |
| Auth | bearer token (+ Cloudflare Access when hosted) | none — inherits your local API |
| Selected by | client config (`url`) | client config (`command`) |

Use **HTTP** unless you specifically want the client to manage the process.

> Connecting to the **hosted** instance also needs Cloudflare Access service
> token headers. That setup — tunnel ingress, Access policies, credential
> rotation — is in **[MCP-HOSTING.md](MCP-HOSTING.md)**.

---

> **In a hurry?** The running app has the same instructions built in — open
> **Help** (top right) → *Connect an AI agent (MCP)*. It fills the snippets below
> in with your endpoint and token, ready to copy.

## Prerequisites

**Connecting to the hosted instance over HTTP?** None — skip to
[Client configuration](#client-configuration).

**Running it locally?**

1. **Node.js 20+** (22 recommended)
2. **BeeDocs API running** (default `http://localhost:5080`)

```bash
# from repo root — starts API :5080, web :5173, and MCP over HTTP :5090
./scripts/start.sh
# or API only:
cd src/BeeDocs.Api && dotnet run
```

3. **MCP package installed & built** — `start.sh` does this for you on first
   run. By hand, for stdio clients that spawn the process themselves:

```bash
cd src/beedocs-mcp
# Node 22 if you use nvm:
# export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
pnpm install
pnpm build
```

Verify the API, and the MCP server if you expect it running:

```bash
curl -s http://localhost:5080/api/health
# {"status":"ok","service":"BeeDocs.Api"}

curl -s http://localhost:5090/healthz
# {"status":"ok","service":"beedocs-mcp","api":"http://localhost:5080"}
```

## Environment variables

Read by the MCP **server** process — irrelevant if you are connecting to a
server someone else is running.

| Variable | Default | Meaning |
|----------|---------|---------|
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `BEEDOCS_API_URL` | `http://localhost:5080` | Base URL of BeeDocs API (no trailing slash required) |
| `BEEDOCS_URL` | (fallback) | Same as `BEEDOCS_API_URL` if set |
| `MCP_HTTP_PORT` | `5090` | Listen port (http only) |
| `MCP_HTTP_HOST` | `0.0.0.0` | Bind address (http only) |
| `MCP_AUTH_TOKEN` | _(unset)_ | Required `Authorization: Bearer` token (http only). Unset = no auth, and the server logs a warning |

## Run manually (debug)

**stdio** — waits on stdin, status on stderr:

```bash
cd src/beedocs-mcp
export BEEDOCS_API_URL=http://localhost:5080
pnpm start
# [beedocs-mcp] connected (API http://localhost:5080)
```

**HTTP**:

```bash
cd src/beedocs-mcp
MCP_TRANSPORT=http MCP_HTTP_PORT=5090 MCP_AUTH_TOKEN=dev-token \
  BEEDOCS_API_URL=http://localhost:5080 node dist/index.js
# [beedocs-mcp] http transport listening on http://0.0.0.0:5090/mcp (API …, auth enabled)
```

Smoke-test it without a client:

```bash
curl -s -X POST http://localhost:5090/mcp \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

For TypeScript without build:

```bash
pnpm dev
```

---

## Client configuration

Pick **one** of the two sections below — [HTTP](#option-a-http-transport) or
[stdio](#option-b-stdio-transport). Don't register both under the same server name.

---

## Option A: HTTP transport

Two URLs, depending on which server you're talking to:

| Target | URL | Headers |
|---|---|---|
| Local (`./scripts/start.sh`) | `http://localhost:5090/mcp` | `Authorization: Bearer dev-token` |
| Hosted (K3S) | `https://mcp.<domain>/mcp` | `Authorization` + the two `CF-Access-*` headers |

Hosted credentials: `./scripts/deploy-k3s.sh mcp-token` for the bearer token,
and the Cloudflare service token from
[MCP-HOSTING.md](MCP-HOSTING.md#3-cloudflare-access-for-mcp-service-token). The
examples below show the local URL; swap in the hosted one and add the
`CF-Access-Client-Id` / `CF-Access-Client-Secret` headers alongside.

### Claude Code / Claude CLI

```bash
claude mcp add --transport http beedocs http://localhost:5090/mcp \
  -H "Authorization: Bearer dev-token"
```

Hosted:

```bash
claude mcp add --transport http beedocs https://mcp.example.com/mcp \
  -H "Authorization: Bearer <mcp-token>" \
  -H "CF-Access-Client-Id: <client-id>.access" \
  -H "CF-Access-Client-Secret: <client-secret>"
```

Add `-s user` to register it globally instead of for the current project.

### Cursor

In **`.cursor/mcp.json`** (project) or global Cursor MCP settings:

```json
{
  "mcpServers": {
    "beedocs": {
      "url": "http://localhost:5090/mcp",
      "headers": {
        "Authorization": "Bearer dev-token"
      }
    }
  }
}
```

A `url` key instead of `command` is what selects the HTTP transport.

### VS Code (GitHub Copilot / MCP)

In `.vscode/mcp.json` (or user MCP settings):

```json
{
  "servers": {
    "beedocs": {
      "type": "http",
      "url": "http://localhost:5090/mcp",
      "headers": {
        "Authorization": "Bearer dev-token"
      }
    }
  }
}
```

### Clients that only speak stdio

Some hosts (Claude Desktop, Grok's `config.toml`, older Continue builds) can
only spawn a subprocess. Bridge to an HTTP server with `mcp-remote`, which is a
stdio server on one side and an HTTP client on the other — no BeeDocs clone
needed:

```json
{
  "mcpServers": {
    "beedocs": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "http://localhost:5090/mcp",
        "--header", "Authorization: Bearer dev-token"
      ]
    }
  }
}
```

Check your client's current docs first — remote MCP support is being added
steadily, and a native `url` field is always preferable to the bridge.

### Verify

Ask the agent to run `beedocs_health`. It returns the API URL the *server* is
using, which confirms the whole chain:

```json
{ "ok": true, "api": "http://localhost:5080", "status": "ok", "service": "BeeDocs.Api" }
```

---

## Option B: stdio transport

Use an **absolute path** to this repo (examples below use `REPO` as a placeholder).
Requires `pnpm install && pnpm build` in `src/beedocs-mcp` first.

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

### Both transports

| Symptom | Fix |
|---------|-----|
| Tools fail with connection errors | Start API: `./scripts/start.sh` or `dotnet run` in `src/BeeDocs.Api` |
| Empty tool list in client | Restart the MCP host app; for stdio, rebuild the package first |
| CORS / browser issues | MCP does not use the browser; only the API URL matters |

### stdio only

| Symptom | Fix |
|---------|-----|
| `ENOENT` on `dist/index.js` | Run `pnpm build` in `src/beedocs-mcp` |
| Wrong Node version / pnpm sqlite errors | Use Node 20+ or 22; `export PATH` to nvm Node 22 |
| Want a remote API | Set `BEEDOCS_API_URL=https://your-host` in the MCP `env` block — or switch to the HTTP transport and drop the local process entirely |

### HTTP only

| Symptom | Fix |
|---------|-----|
| `401` with a JSON-RPC error body | Bearer token is wrong. Local default is `dev-token`; hosted comes from `./scripts/deploy-k3s.sh mcp-token` |
| `404 Not found. MCP endpoint is /mcp.` | URL is missing the `/mcp` path |
| Connection refused on `:5090` | Server isn't running — `./scripts/start.sh`, or check `SKIP_MCP=1` wasn't set |
| HTML login page instead of JSON | Hosted only: Cloudflare Access policy should be `Service Auth`, and the `CF-Access-*` headers must be present — see [MCP-HOSTING.md](MCP-HOSTING.md#troubleshooting) |

### Logs

- **stdout** is reserved for the MCP protocol in stdio mode — never pipe
  application logs there. HTTP mode has no such constraint.
- Status goes to **stderr** either way:
  - stdio: `[beedocs-mcp] connected (API …)`
  - http: `[beedocs-mcp] http transport listening on … (API …, auth enabled)`
- Locally, `start.sh` streams it and writes `scripts/.logs/mcp.log`.
  On K3S: `./scripts/deploy-k3s.sh logs`.

## Security notes

- BeeDocs itself has **no authentication** (MVP), so the MCP server has the same
  unauthenticated access to the API that anything else on the network does.
- Destructive tools (`beedocs_delete_*`) permanently remove data. Any client you
  connect can call them.
- **stdio** inherits whatever reach your machine has — there is nothing to
  configure, and nothing protecting the API behind it.
- **HTTP** adds `MCP_AUTH_TOKEN`. Leaving it unset means every caller that can
  reach the port has full read/write access; the server logs a loud warning at
  startup when that happens. Fine on localhost, never fine when exposed.
- The hosted instance layers Cloudflare Access on top of that token. Note that
  Access only protects the tunnel path — the K3S NodePorts must be firewalled or
  it can be bypassed entirely. See
  [MCP-HOSTING.md](MCP-HOSTING.md#firewall-the-nodeports-first).

## Package layout

```
src/beedocs-mcp/
  package.json
  tsconfig.json
  Dockerfile      # image for the hosted (http) deployment
  src/
    index.ts      # entry; picks transport, builds the server
    http.ts       # Streamable HTTP transport + bearer auth + /healthz
    client.ts     # HTTP → BeeDocs.Api
    tools.ts      # all MCP tools
    resources.ts  # MCP resources
    prompts.ts    # MCP prompts
  dist/           # build output (git-ignored)
```

`createBeeDocsServer()` in `index.ts` registers the tools, resources, and
prompts, and both transports call it — so the two connection modes cannot drift
apart in what they expose.

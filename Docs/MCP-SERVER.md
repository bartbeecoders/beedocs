# Connecting AI agents to BeeDocs (MCP)

BeeDocs ships an **MCP (Model Context Protocol) server** that exposes the full REST API to AI agents: books, chapters, pages (Markdown), and diagrams (BeeDiagram / Mermaid / C4).

There are **two ways to connect**, and they expose exactly the same tools,
resources, and prompts.

### 1. HTTP — point at a URL (recommended)

Nothing to install. The server runs as a process you connect *to*, either the
hosted K3S instance or the one `./scripts/start.sh` starts on `:5090`.

```
┌─────────────┐   Streamable HTTP   ┌──────────────┐  HTTP  ┌─────────────┐
│ AI client   │ ◄─────────────────► │ BeeDocs.Mcp  │ ─────► │ BeeDocs.Api │
│ Cursor/etc. │      POST /mcp      │  (.NET)      │        │             │
└─────────────┘                     └──────────────┘        └─────────────┘
                                     hosted, or :5090 locally
```

### 2. stdio — the client spawns it

The classic setup: your client launches `dotnet BeeDocs.Mcp.dll` (or
`dotnet run` from `src/BeeDocs.Mcp`) as a subprocess and talks JSON-RPC over
stdin/stdout. Requires a clone and the .NET 10 SDK/runtime on that machine.

```
┌─────────────┐  stdio (JSON-RPC)  ┌──────────────┐  HTTP  ┌─────────────┐
│ AI client   │ ◄───────────────► │ BeeDocs.Mcp  │ ─────► │ BeeDocs.Api │
│ Cursor/etc. │                   │  (.NET)      │        │ :5080       │
└─────────────┘                   └──────────────┘        └─────────────┘
```

### Which one?

| | HTTP | stdio |
|---|---|---|
| Install per machine | none | clone + .NET 10 |
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

1. **.NET 10 SDK** (runtime is enough to run a published build)
2. **BeeDocs API running** (default `http://localhost:5080`)

```bash
# from repo root — starts API :5080, web :5200, and MCP over HTTP :5090
./scripts/start.sh
# or API only:
cd src/BeeDocs.Api && dotnet run
```

3. **MCP project** — `start.sh` / `start.ps1` run `dotnet run` in
   `src/BeeDocs.Mcp`. For stdio clients that spawn the process themselves:

```bash
cd src/BeeDocs.Mcp
dotnet build
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
| `BEEDOCS_API_KEY` | _(unset)_ | The **API's** shared secret (`BeeDocs:ApiKey`), sent as `X-Api-Key`. Required once the API has sign-in enabled — an agent has no session cookie. See [USERS-AND-ROLES.md](./USERS-AND-ROLES.md) |
| `MCP_HTTP_PORT` | `5090` | Listen port (http only) |
| `MCP_HTTP_HOST` | `0.0.0.0` | Bind address (http only) |
| `MCP_AUTH_TOKEN` | _(unset)_ | Required `Authorization: Bearer` token (http only). Unset = no auth, and the server logs a warning |
| `MCP_PATH_BASE` | _(unset)_ | Optional URL prefix when reverse-proxied (e.g. `/beedocs-mcp`) |

`BEEDOCS_API_KEY` and `MCP_AUTH_TOKEN` are different secrets for different hops:
the first authenticates this server *to BeeDocs.Api*, the second authenticates
*clients to this server*. Give them different values.

## Run manually (debug)

**stdio** — waits on stdin, status on stderr:

```bash
cd src/BeeDocs.Mcp
export BEEDOCS_API_URL=http://localhost:5080
dotnet run
```

**HTTP**:

```bash
cd src/BeeDocs.Mcp
MCP_TRANSPORT=http MCP_HTTP_PORT=5090 MCP_AUTH_TOKEN=dev-token \
  BEEDOCS_API_URL=http://localhost:5080 dotnet run --no-launch-profile
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
| Local (`./scripts/start.sh`) | `http://localhost:5090/mcp` | _none by default_ (`Authorization: Bearer <token>` if you set `MCP_AUTH_TOKEN`) |
| Hosted (K3S) | `https://mcp.<domain>/mcp` | `Authorization` + the two `CF-Access-*` headers |

Hosted credentials: `./scripts/deploy-k3s.sh mcp-token` for the bearer token,
and the Cloudflare service token from
[MCP-HOSTING.md](MCP-HOSTING.md#3-cloudflare-access-for-mcp-service-token). The
examples below show the local URL; swap in the hosted one and add the
`CF-Access-Client-Id` / `CF-Access-Client-Secret` headers alongside.

### Claude Code / Claude CLI

```bash
claude mcp add --transport http beedocs http://localhost:5090/mcp
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
Requires the .NET 10 SDK (`dotnet run`) or a published `BeeDocs.Mcp.dll`.

```bash
# resolve once
export REPO="/ABSOLUTE/PATH/TO/BeeDocs"
```

### Grok (this CLI / TUI)

BeeDocs is registered as an MCP server for Grok in two places:

1. **Project:** `.grok/config.toml` (in this repo)
2. **User:** `~/.grok/config.toml` under `[mcp_servers.beedocs]`

```toml
[mcp_servers.beedocs]
command = "dotnet"
args = [
  "run",
  "--no-build",
  "--project",
  "/ABSOLUTE/PATH/TO/BeeDocs/src/BeeDocs.Mcp/BeeDocs.Mcp.csproj",
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
      "command": "dotnet",
      "args": [
        "run",
        "--no-launch-profile",
        "--project",
        "/ABSOLUTE/PATH/TO/BeeDocs/src/BeeDocs.Mcp/BeeDocs.Mcp.csproj"
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
      "command": "dotnet",
      "args": [
        "run",
        "--no-launch-profile",
        "--project",
        "/ABSOLUTE/PATH/TO/BeeDocs/src/BeeDocs.Mcp/BeeDocs.Mcp.csproj"
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
  dotnet run --no-launch-profile --project /ABSOLUTE/PATH/TO/BeeDocs/src/BeeDocs.Mcp/BeeDocs.Mcp.csproj
```

Or add to `.mcp.json` in the project root:

```json
{
  "mcpServers": {
    "beedocs": {
      "command": "dotnet",
      "args": [
        "run",
        "--no-launch-profile",
        "--project",
        "src/BeeDocs.Mcp/BeeDocs.Mcp.csproj"
      ],
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
      "command": "dotnet",
      "args": [
        "run",
        "--no-launch-profile",
        "--project",
        "${workspaceFolder}/src/BeeDocs.Mcp/BeeDocs.Mcp.csproj"
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
command: dotnet
args:    [run, --no-launch-profile, --project, <repo>/src/BeeDocs.Mcp/BeeDocs.Mcp.csproj]
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

## Protocol revision

BeeDocs.Mcp is built on the official C# SDK (`ModelContextProtocol` 2.1.0), which
speaks the **2026-07-28** revision and every earlier one back to `2024-11-05`.
The revision is picked per request, so nothing here needs configuring:

- A 2026-07-28 client sends `server/discover` and carries its protocol version,
  identity, and capabilities in `_meta` on every request. There is no
  `initialize` handshake and no `Mcp-Session-Id`; requests must also carry the
  `MCP-Protocol-Version`, `Mcp-Method`, and (where a name/URI applies)
  `Mcp-Name` headers, which the server enforces.
- An older client that opens with `initialize` still negotiates its own revision
  and keeps working — the SDK answers both dialects on the same endpoint.

What BeeDocs adds on top of the SDK defaults (`Program.cs`):

| Behaviour | Why |
|---|---|
| `tools/list`, `prompts/list`, `resources/list`, `resources/templates/list` sorted by name/URI | 2026-07-28 asks for a deterministic order so clients can cache the listing and keep LLM prompt-cache hits; reflection order is not stable across builds |
| Those listings — and `beedocs://diagram/catalog` — return `ttlMs: 300000`, `cacheScope: "public"` (SEP-2549) | They are compiled into the assembly: identical for every caller and unchanged until the process restarts. Live resource reads keep the SDK's "immediately stale, private" default |

Deprecated-in-2026-07-28 features are unused: no Roots, no Sampling, and no
Logging — the server logs to stderr (stdio) or the ASP.NET logger (HTTP), never
to the client. Multi Round-Trip Requests are not needed either; every tool takes
its arguments up front and returns a `"complete"` result.

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
| Project / DLL not found | `dotnet build` in `src/BeeDocs.Mcp` (or publish and point at `BeeDocs.Mcp.dll`) |
| Wrong Node version / pnpm sqlite errors | Use Node 20+ or 22; `export PATH` to nvm Node 22 |
| Want a remote API | Set `BEEDOCS_API_URL=https://your-host` in the MCP `env` block — or switch to the HTTP transport and drop the local process entirely |

### HTTP only

| Symptom | Fix |
|---------|-----|
| `401` with a JSON-RPC error body | Bearer token is wrong. Local runs have no auth unless `MCP_AUTH_TOKEN` is set; hosted comes from `./scripts/deploy-k3s.sh mcp-token` |
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
src/BeeDocs.Mcp/
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

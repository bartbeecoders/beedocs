# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

BeeDocs is a self-hosted documentation platform (BookStack-style) for software +
hardware systems architecture: Books → Pages, Markdown editor, Mermaid/C4
diagrams, and a custom draw.io-style diagram editor ("BeeDiagram"). Three
components in one repo, no separate database container (SurrealDB is embedded):

```
src/BeeDocs.Api/    .NET 10 minimal API — REST endpoints, SurrealDB (embedded RocksDB)
src/beedocs-web/    React 19 + Vite + TypeScript — the workspace UI
src/beedocs-mcp/    Node/TypeScript MCP server — exposes the API to AI agents (stdio or HTTP)
```

There is currently no automated test suite in this repo (no test project/folder).

## Commands

### Run everything (recommended)

```bash
./scripts/start.sh        # bash/WSL/Linux/macOS
./scripts/start.ps1       # native PowerShell (Windows)
```

Starts API (`:5080`), Vite UI (`:5200` in the scripts, `:5173` if run manually
via `vite dev` — see `vite.config.ts`), and MCP over HTTP (`:5090`, bearer
`dev-token`). It kills anything already bound to those ports first, so re-running
is always a clean restart. Ctrl+C stops all three; logs land in `scripts/.logs/`.

- `SKIP_MCP=1 ./scripts/start.sh` — skip the MCP HTTP process (stdio-transport agents spawn their own).
- `API_PORT=5081 WEB_PORT=5174 MCP_PORT=5091 ./scripts/start.sh` — override ports.
- On a fresh clone this also runs `pnpm install`/`pnpm build` for web and MCP the first time (adds a few seconds).

### API (.NET)

```bash
cd src/BeeDocs.Api
dotnet run                     # http://localhost:5080, health at /api/health
```

No `dotnet test` project exists yet — verify API changes by curling the running
server or exercising them through the UI/MCP tools.

### Web (React + Vite + pnpm)

```bash
cd src/beedocs-web
pnpm install
pnpm dev        # http://localhost:5173, proxies /api and /uploads to :5080
pnpm build      # tsc -b && vite build
pnpm lint       # eslint .
```

### MCP server (Node/TypeScript)

```bash
cd src/beedocs-mcp
pnpm install
pnpm build      # tsc -p tsconfig.json -> dist/ (gitignored)
pnpm dev        # tsx src/index.ts, no build step
pnpm typecheck  # tsc --noEmit
```

Requires the API running (`BEEDOCS_API_URL`, default `http://localhost:5080`).
Transport is chosen by `MCP_TRANSPORT` (`stdio` default, or `http`); see
`Docs/MCP-SERVER.md` for the full env var table and client wiring (Claude Code,
Cursor, VS Code, Claude Desktop, Grok).

### Docker / deploy

```bash
podman compose up --build          # or docker compose up --build
./scripts/deploy-k3s.sh            # build -> push -> deploy -> status (K3S)
./scripts/deploy-k3s.sh logs       # tail API + MCP container logs
./scripts/deploy-k3s.sh mcp-token  # print the MCP bearer token
```

## Architecture

```
UI (React+Vite, :5173/:5200) --/api proxy--> BeeDocs.Api (.NET, :5080) --SurrealDb.Net--> SurrealDB (embedded RocksDB, data/surreal)
                                                     ^
                                                     | HTTP (client.ts)
                                        beedocs-mcp (Node, stdio or HTTP :5090)
```

- **BeeDocs.Api** is a single-file minimal-API (`Program.cs`) mapping `/api/books`,
  `/api/books/{id}/chapters`, `/api/books/{id}/pages`, `/api/pages/{id}`,
  `/api/books/{id}/diagrams`, `/api/diagrams/{id}`, `/api/uploads`, plus
  `/api/health` and `/api/version`. Business logic lives in `Services/`
  (`DocumentService` for books/chapters/pages, `DiagramService` for diagrams);
  entities are in `Models/Entities.cs` (`Book`, `Chapter`, `Page`,
  `PageRevision`, `Diagram` — all `SurrealDb.Net` `Record` types). Every page
  update writes a `PageRevision` snapshot.
- **SurrealDB** runs embedded — RocksDB-backed by default
  (`data/surreal` under the API content root, configurable via
  `BeeDocs:DataPath`), or `mem://` for in-process testing. There is no separate
  DB server or connection string to manage in dev.
- **Uploaded images** are served from `BeeDocs:UploadsPath` (default
  `data/uploads`) at `/uploads/*`, separate from the RocksDB data dir so
  container deployments can point both at the same persistent volume.
- **Production hosting**: the Dockerfile builds the web app into the API's
  `wwwroot/`; `Program.cs` serves static files and falls back to `index.html`
  (SPA routing) when `wwwroot` exists — one process serves UI + API + uploads.
- **beedocs-web** is a single-page "workspace" shell (`WorkspaceShell.tsx`):
  header, resizable/collapsible left library tree (`NavTree.tsx`), center
  editor canvas, resizable/collapsible right properties pane
  (`PropertiesPane.tsx`). Page editing (`HybridPageEditor.tsx`) renders
  Markdown with embedded Mermaid and `beediagram`/`beediagram-ref` fences
  (`markdownFences.ts`, `pageBlocks.ts`). All API calls go through the typed
  client in `api.ts`.
- **BeeDiagram** is a custom diagram format (`kind: "beediagram"`, stored as a
  JSON `nodes`/`edges`/`viewport` document — see `diagram/beeModel.ts`) with two
  interchangeable editors on the same document:
  - **Studio** (`components/studio/`) — the default draw.io-style editor:
    shape palette, infinite canvas, hover-to-connect arrows + 16 fixed
    connection points, alignment guides, format panel. See
    `Docs/DIAGRAM-STUDIO.md` for the full interaction model and JSON schema.
  - **Classic** (`BeeDiagramEditor.tsx`) — the original compact canvas, still
    used for inline ` ```beediagram ` fences inside Markdown pages.
  Both read/write the same JSON, so a diagram looks identical in either editor,
  in page previews, and in the PDF/HTML export (`export/`).
- **beedocs-mcp** wraps the whole REST API for AI agents. `createBeeDocsServer()`
  in `src/index.ts` registers tools (`tools.ts`), resources (`resources.ts`),
  and prompts (`prompts.ts`) once, and both transports (`http.ts` for
  Streamable HTTP, stdio built into the SDK) call it — so the two connection
  modes can't drift apart in what they expose. `client.ts` is the thin HTTP
  client back to `BeeDocs.Api`. Full tool catalog: `Docs/MCP-TOOLS.md`.
  - stdio: no auth, inherits whatever network access the host process has.
  - HTTP: stateless (fresh `McpServer` per request, no session pinning),
    optional `MCP_AUTH_TOKEN` bearer auth — logs a loud warning if unset.
  - Hosted (K3S) instance additionally sits behind Cloudflare Access with a
    service token; see `Docs/MCP-HOSTING.md` for the two-hostname setup
    (`docs.<domain>` interactive SSO vs `mcp.<domain>` service auth) and why the
    NodePorts must be firewalled so Access can't be bypassed directly.

## Versioning

`<Version>` in `src/BeeDocs.Api/BeeDocs.Api.csproj` is `MAJOR.MINOR.BUILD`. The
API serves it at `/api/version`/`/api/health`, and the web UI shows it as a pill
in the header. `scripts/deploy-k3s.sh` auto-increments only the **build**
digit on every deploy — bump major/minor by hand when warranted. Commit the
bumped csproj after deploying so the pill maps to a known commit.
`NO_BUMP=1 ./scripts/deploy-k3s.sh` redeploys the current version unchanged.

## Key docs

- `Docs/ARCHITECTURE.md` — one-page architecture summary.
- `Docs/MCP-SERVER.md` — connecting AI agent clients (stdio vs HTTP, per-client config).
- `Docs/MCP-HOSTING.md` — running the MCP server on K3S behind Cloudflare Access.
- `Docs/MCP-TOOLS.md` — full MCP tool/resource/prompt catalog.
- `Docs/DIAGRAM-STUDIO.md` — BeeDiagram Studio editor interactions and JSON format.
- `Vibecoding/Instructions.md` — product goals/vision behind the MVP.

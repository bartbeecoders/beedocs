# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

BeeDocs is a self-hosted documentation platform (BookStack-style) for software +
hardware systems architecture: Shelves → Books → Pages, Markdown editor, Mermaid/C4
diagrams, and a custom draw.io-style diagram editor ("BeeDiagram"). Three
components in one repo, no separate database container (SQLite is embedded):

```
src/BeeDocs.Api/    .NET 10 minimal API — REST endpoints, SQLite (file-backed)
src/BeeDocs.Mcp/    .NET 10 MCP server — exposes the API to AI agents (stdio or HTTP)
src/BeeDocs.Host/   .NET worker — Windows supervisor for API + MCP
src/beedocs-web/    React 19 + Vite + TypeScript — the workspace UI
src/beedocs-mcp/    Legacy Node MCP (superseded by BeeDocs.Mcp)
```

There is currently no automated test suite in this repo (no test project/folder).

## Commands

### Run everything (recommended)

```bash
./scripts/start.sh        # bash/WSL/Linux/macOS
./scripts/start.ps1       # native PowerShell (Windows)
```

Starts API (`:5080`), Vite UI (`:5200` in the scripts, `:5173` if run manually
via `vite dev` — see `vite.config.ts`), and MCP over HTTP (`:5090`, no auth by
default — set `MCP_AUTH_TOKEN` to require a bearer token). It kills anything
already bound to those ports first, so re-running
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

### MCP server (.NET)

```bash
cd src/BeeDocs.Mcp
dotnet run                              # stdio (default)
# HTTP:
# MCP_TRANSPORT=http MCP_HTTP_PORT=5090 MCP_AUTH_TOKEN=dev-token \
#   BEEDOCS_API_URL=http://localhost:5080 dotnet run --no-launch-profile
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
UI (React+Vite, :5173/:5200) --/api proxy--> BeeDocs.Api (.NET, :5080) --Microsoft.Data.Sqlite--> SQLite (data/sqlite/beedocs.db)
 ^
 | HTTP
 BeeDocs.Mcp (.NET, stdio or HTTP :5090)
```

- **BeeDocs.Api** is a single-file minimal-API (`Program.cs`) mapping `/api/shelves`,
  `/api/books`,
  `/api/books/{id}/chapters`, `/api/books/{id}/pages`, `/api/pages/{id}`,
  `/api/books/{id}/diagrams`, `/api/diagrams/{id}`, `/api/books/{id}/slides`,
  `/api/slides/{id}`, `/api/uploads`, `/api/search`,
  `/api/auth/*`, `/api/users/*`, `/api/stats`, plus `/api/health` and `/api/version`.
  Business logic lives in `Services/`
  (`DocumentService` for shelves/books/chapters/pages, `DiagramService` for
  diagrams, `SlideDeckService` for slide decks);
  entities are in `Models/Entities.cs` (`Shelf`, `Book`, `Chapter`, `Page`,
  `PageRevision`, `Diagram`, `SlideDeck` — plain POCOs with string ids).
- **Shelves** are the level above books: `shelf` rows plus a nullable
  `book.shelf_id`, so a book sits on at most one shelf and a book with no shelf
  sits at the library root — which is where every book was before the feature, so
  the migration needs no backfill. A shelf holds no content, so `DeleteShelfAsync`
  clears `shelf_id` on its books instead of cascading. `shelf.published` serves
  that shelf as a reader website at `/bookshelf-serve/{slug}`
  (`GET /api/bookshelf-serve/{name}`). `UpdateBookRequest` follows
  one convention for all three optional fields (`ShelfId`, `OwnerId`,
  `Description`): **null leaves it alone, `""` clears it** — the UI sends partial
  updates, and reading an omitted field as "clear it" is how assigning an owner
  used to delete a book's description. The tree groups books by `shelfId` rather
  than nesting them (`WorkspaceContext` keeps one flat `books` list), so a book has
  one identity and one loaded set of children wherever it is drawn.
- **Storage providers** let a shelf's content bodies live in the cloud instead of
  SQLite: rows in `storage_provider` (kinds `azure-blob` via connection string,
  `google-drive` via OAuth consent — secrets write-only, llm_provider-style,
  leaving `StorageProviderService` only through `ResolveAsync`), assigned per
  shelf with `POST /api/shelves/{id}/storage` (admin, synchronous, minutes-scale;
  UI gives it a 600s timeout) and configured at `/api/storage-providers` (admin;
  the Google callback is the one anonymous route — its HMAC-signed `state` is the
  auth). **Only bodies move** (`page.content`, `page_revision.content`,
  `diagram.source`, `slide_deck.source`); tree, metadata, `updated_at` and the
  search index stay local. The load-bearing invariant is the per-row
  `content_ref` column: NULL = body inline (pre-feature behavior), else
  `"{providerId}:{key}"` — readers resolve the ref via `ContentResolver`, never
  the shelf flag, which only directs *new* writes. That makes
  `ShelfContentMover` idempotent (each row is one atomic UPDATE; re-POST resumes
  a crashed move) and is why cloud→cloud moves need no shelf history. Provider
  I/O always happens *before* a SQLite transaction opens (see `DrainBatchAsync`'s
  two-phase restructure and every domain-service save); a provider failure on
  save falls back inline rather than losing text, on read maps to 503 via the
  `/api`-group filter in `Program.cs`. Deleting a provider is refused (409) while
  any shelf or stranded `content_ref` uses it; deleting a shelf repatriates
  first; moving a book between shelves relocates its bodies. Settings UI:
  `StorageProviders.tsx` (reuses the `llm-*` card chrome); shelf assignment:
  `ShelfStorageField` in `PropertiesPane.tsx` with a confirm modal. Uploads stay
  local (v1).
- **SQLite** is file-backed by default (`data/sqlite/beedocs.db` under the API
  content root, directory configurable via `BeeDocs:DataPath`, or a full
  `ConnectionStrings:Sqlite`). There is no separate DB server.
- **Search** is SQLite FTS5 over a `search_doc` projection built by
  `SearchIndexService`, which is also where Markdown is reduced to indexable text
  (diagram JSON contributes only its shape labels). Nothing calls the indexer to
  register a write: triggers on `page`/`diagram`/`book`/`chapter`/`shelf` record changes
  in `search_queue`, and the queue is drained at startup and before each search,
  so the index stays correct whoever wrote the row — UI, MCP, import, or direct
  SQL. Exposed at `/api/search`, `/api/v1/search`, and the `beedocs_search` MCP
  tool; the UI opens it with Ctrl+K (`SearchPalette.tsx`).
- **Uploaded images** are served from `BeeDocs:UploadsPath` (default
  `data/uploads`) at `/uploads/*`, separate from the SQLite data dir so
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
- **Page grid layout** (`pageLayout.ts`) — a page can arrange its blocks in a
  COLS×ROWS grid of cells instead of one top-to-bottom flow. The whole feature
  lives in the page's Markdown as HTML comment markers
  (`<!-- bee:layout 2x2 -->` + `<!-- bee:cell N -->`), parsed fence-aware so
  diagram JSON can never tear a page apart; no marker = the classic single
  flow, and switching back to 1×1 serializes bare Markdown with no markers.
  The hybrid editor renders one block list per cell (`data-cell-root`,
  layout picker in the insert toolbar) and `useBlockReorder` addresses blocks
  as `{cell, index}` so the same drag handle moves blocks between cells (←/→
  on a focused handle is the keyboard path). `MarkdownView` splits into a
  `.page-grid` of per-cell bodies — which keeps inline-fence occurrence
  indices per cell — and `buildPageOutline`, the PDF exporter
  (`.export-grid`) and the reader site follow the same cell order; block ids
  (`outlineId`) count across cells. Server-side, `MarkdownDoc.ParseProse`
  skips whole-line HTML comments, which is what keeps the markers out of
  DOCX exports and the search index. Grids collapse to one column under
  900 px.
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
  Shapes are declared once in `diagram/shapeLibrary.ts` (palette groups) and
  drawn from `diagram/shapes.ts` (primitive geometry); the Azure service
  stencils live in `diagram/azureIcons.ts`. `diagram/catalog.ts` serialises all
  of it, and `scripts/gen-diagram-catalog.mjs` (run by `pnpm build`) writes
  `src/BeeDocs.Mcp/diagram-catalog.json`, which the MCP server embeds — so a new
  shape reaches AI agents without a second edit. Regenerate + `dotnet build`
  BeeDocs.Mcp after touching those files.
- **Isometric diagrams** (`kind: "isometric"`) are a second from-scratch editor
  in `src/beedocs-web/src/isometric/` — no third-party diagram library. The
  document is a tile grid in 2:1 dimetric projection: `items` on integer tile
  coordinates, `connectors` between items, `zones` (floor rectangles) and
  `texts`, all in one JSON source (`isoModel.ts`). Shapes are hand-drawn
  primitive lists in `isoShapes.ts` with the three face shades derived from one
  base colour; `isoRender.ts` holds the world-space geometry shared by the
  editor canvas, the read-only view and `isoSvg.ts` — which is why isometric
  fences render for real in PDF export. The editor deliberately mirrors the
  BeeDiagram Studio: same controller shape (`useIsoController` ≈
  `useStudioController`), same `studio-*` CSS classes on a fixed-white canvas,
  same mouse/keyboard verbs (palette click-cascade/drag, marquee, space-pan,
  Ctrl+wheel zoom, hover-to-connect arrows where a *click* makes a connected
  copy, F2/type-to-edit labels, undo/redo/clipboard). Entry points are lazy
  (`IsometricEditor` / `IsometricView`, ~15 kB chunk); pages embed via
  ```` ```isometric-ref ```` fences (explorable read-only, editing on the
  diagram's own page). Agents build these with
  `beedocs_create_isometric_with_items` / `beedocs_update_isometric_items`
  (`BeeDocs.Mcp/Tools/IsometricTools.cs`); the shape id list is duplicated
  there in `IsometricCatalog` — keep it in sync with `isoShapes.ts`.
- **Slides** are PowerPoint-style presentations stored one JSON document per
  deck (`slide_deck` table, same storage shape as `diagram`): an ordered list of
  slides, each an ordered list of positioned elements, where **element array
  order is z-order**. The schema's one source of truth is
  `src/beedocs-web/src/slides/slideModel.ts` — the server stores the document
  verbatim and reads only element text + notes (search) and the slide count
  (tree badge), so new element fields need no server change. The designer
  (`slides/SlideEditor.tsx`: filmstrip · canvas · format panel) and the
  full-screen presenter (`slides/SlidePresenter.tsx`) share one renderer
  (`slides/SlideView.tsx`), so a deck looks identical everywhere. Read-only
  accounts get a slide list plus Present — presenting is deliberately not a
  write affordance. A deck can be saved as an app-wide **template**
  (`slide_template`, copied on create via `CreateSlideDeckRequest.TemplateId`)
  and exported as a real PowerPoint file (`SlideDeckPptxExporter`, hand-built
  OOXML at `GET /api/slides/{id}/export/pptx`) — the same .pptx is the Google
  Slides path, since Slides imports it natively. See `Docs/SLIDES.md`.
- **Ownership & page history** — `book.owner_id` / `page.owner_id` name the
  account answerable for a document (a page inherits its book's owner at
  creation, falling back to its creator); neither grants any permission, which
  stays purely role-based. `page_revision` is the page's **change log**: one row
  per change holding the state the page was *left in*, plus `changed_by` and a
  `changed_by_name` snapshot that survives a rename or a deleted account. The
  newest row therefore mirrors the live page, which is where `PageDto`'s
  `updatedByName` comes from — no extra column. Consecutive saves by the same
  author within a 5-minute sliding window coalesce into that newest row
  (`WriteUpdatedRevisionAsync`) — auto-save fires every 1.5s while someone
  types, so without this every keystroke burst would become its own tracked
  copy; a row marks a sitting, not a save. Served by
  `GET /api/pages/{id}/history` and rendered in the properties pane.
  `ICurrentUserAccessor` is how the singleton `DocumentService` reaches the acting
  user without an actor parameter on every method of four interfaces.
  Rows written before the log existed are labelled `change_kind = 'legacy'` by the
  migration rather than reinterpreted — they hold the state a page moved *away*
  from. **Change tracking** (`page.track_changes` + `page.max_revisions`, both on
  `PUT /api/pages/{id}`) is the owner-gated layer on top: only the page's owner or
  an admin may *change* the two fields (echoing current values is always fine, so
  editors' saves pass), and while on, `GET /api/pages/{id}/revisions/{revisionId}`
  serves any kept copy in full (404 while off) and each save prunes the log to the
  newest `max_revisions` rows (0 = unlimited). New columns reach existing databases through `AddColumnIfMissingAsync` in
  `DatabaseInitializer`; `CREATE TABLE IF NOT EXISTS` alone would skip them.
  See `Docs/USERS-AND-ROLES.md`.
- **Users & roles** (`Services/UserService.cs`, `PasswordHasher.cs`,
  `AuthEndpointFilter.cs`, `auth/AuthContext.tsx`, `components/UsersPanel.tsx`)
  — accounts in `app_user`, sessions in `user_session`, three fixed roles
  (`UserRoles`: admin / editor / viewer). Passwords are PBKDF2-HMAC-SHA256 with
  the parameters stored alongside the hash, so the cost can be raised later and
  each row upgrades on its owner's next sign-in; the column is selected only on
  the login and change-password paths and never reaches a DTO. **Enforcement is
  opt-in** (`BeeDocs:Auth:Enabled`, default off) — the tables and the seeded
  admin exist either way, so the flag can be flipped without a migration.
  `RequestAuthenticator` resolves a caller once and is shared by the `/api`
  endpoint filter and the `/uploads` middleware (static files answer before any
  endpoint filter, so gating pages without gating uploads would be no gate at
  all). The default rule is read-for-everyone / write-for-editors; only
  `/api/users`, `/api/stats` (its per-author activity list is a register of who
  works on what) and the LLM provider routes carry `RequireRole.Admin` metadata.
  `BeeDocs:ApiKey` authenticates a *machine* (MCP, publishing apps) as admin —
  MCP passes it via `BEEDOCS_API_KEY`. Nothing is seeded: an empty `app_user`
  table means the instance is *unclaimed*, and `POST /api/auth/setup`
  (`SetupScreen.tsx`, gated on `authEnabled && setupRequired` from
  `/api/auth/me`) creates its first admin with a chosen password and signs them
  in. That endpoint's emptiness check lives inside the `INSERT … WHERE NOT
  EXISTS`, so concurrent claims cannot both win; it answers 409 forever after.
  See `Docs/USERS-AND-ROLES.md`.
- **LLM writing help** (`/api/llm`, `Services/LlmProviderService.cs` +
  `LlmClient.cs`, `components/AiAssist.tsx` + `hooks/useLlmAssist.ts`) — inline
  autocomplete and selection actions (rewrite / grammar / format / summarize) in
  the page editor. OpenRouter, xAI, OpenAI and LM Studio all speak the OpenAI
  chat-completions API, so one client covers them; providers are rows in
  `llm_provider` and the key column is read only by `ResolveAsync`, never put in
  a DTO. Every call is proxied by the API so no key reaches the browser.
  `/api/llm` is behind the same `ApiKeyEndpointFilter` as `/api/v1`, which is
  inert unless `BeeDocs:ApiKey` is set — an open port with a stored key is a
  bill waiting to happen, and setting the key also switches the feature off in
  the UI (the browser has nowhere to keep the secret). See
  `Docs/LLM-PROVIDERS.md`.
- **BeeDocs.Mcp** wraps the whole REST API for AI agents (official C# MCP SDK
  2.1.0, protocol revision `2026-07-28` with fallback to older ones).
  Tools/resources/prompts live under `Tools/`, `Resources/`, `Prompts/`; both
  stdio and Streamable HTTP share the same registrations via
  `AddBeeDocsMcpServer` in `Program.cs`, which is also where the request filters
  that sort the listings and stamp their SEP-2549 `ttlMs`/`cacheScope` hints
  live. `BeeDocsApiClient` is the thin HTTP client back to `BeeDocs.Api`. Full
  tool catalog: `Docs/MCP-TOOLS.md`; protocol details: `Docs/MCP-SERVER.md`.
  - stdio: no auth, inherits whatever network access the host process has.
  - HTTP: stateless Streamable HTTP on `/mcp`, optional `MCP_AUTH_TOKEN` bearer
    auth — logs a loud warning if unset. `/healthz` is unauthenticated.
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
- `Docs/SLIDES.md` — slide decks: document format, designer, presentation mode.
- `Docs/USERS-AND-ROLES.md` — accounts, roles, sessions, and the opt-in sign-in wall.
- `Docs/LLM-PROVIDERS.md` — LLM providers, key storage, and the `/api/llm` security trade-off.
- `Vibecoding/Instructions.md` — product goals/vision behind the MVP.

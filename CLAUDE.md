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
  `/api/slides/{id}`, `/api/books/{id}/kanban`, `/api/kanban/{id}`, `/api/books/{id}/project`, `/api/project/{id}`, `/api/books/{id}/notes`, `/api/notes/{id}`, `/api/books/{id}/attachments`, `/api/attachments/{id}`,
  `/api/uploads`, `/api/search`,
  `/api/auth/*`, `/api/users/*`, `/api/stats`, plus `/api/health` and `/api/version`.
  Business logic lives in `Services/`
  (`DocumentService` for shelves/books/chapters/pages, `DiagramService` for
  diagrams, `SlideDeckService` for slide decks, `KanbanBoardService` for kanban
  boards, `ProjectPlanService` for Gantt plans, `NoteService` for OneNote-style
  notes, `AttachmentService` for uploaded
  documents);
  entities are in `Models/Entities.cs` (`Shelf`, `Book`, `Chapter`, `Page`,
  `PageRevision`, `Diagram`, `SlideDeck`, `KanbanBoard`, `ProjectPlan`, `Note`, `Attachment` — plain POCOs with string
  ids).
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
  `google-drive` via OAuth consent, `s3` via access/secret key for AWS S3 and
  anything speaking its API — MinIO, R2, B2, Ceph; `S3ContentStore` is a
  hand-rolled SigV4 client, no AWS SDK, path-style by default when an endpoint
  is given; `POST /api/storage-providers/{id}/s3/create-bucket` PUTs the
  bucket itself — `LocationConstraint` only outside us-east-1, as AWS
  requires — treats `BucketAlreadyOwnedByYou` as success and ends with the
  `/test` probe, so the "Create bucket" button in the settings card reports
  writability, not just existence — secrets write-only, llm_provider-style,
  leaving `StorageProviderService` only through `ResolveAsync`), assigned per
  shelf with `POST /api/shelves/{id}/storage` (admin, synchronous, minutes-scale;
  UI gives it a 600s timeout) and configured at `/api/storage-providers` (admin;
  the Google callback is the one anonymous route — its HMAC-signed `state` is the
  auth). **Only bodies move** (`page.content`, `page_revision.content`,
  `diagram.source`, `slide_deck.source`, `kanban_board.source`, `project_plan.source`, `note.source`); tree, metadata, `updated_at` and the
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
  local (v1). Every store also implements `IBackupStore` (binary,
  name-addressed upload/download/list/delete) — the side backups use.
- **Backup & restore** (`Services/BackupService.cs` + `BackupSchedulerService`,
  `MaintenanceGate.cs`; UI `BackupPanel.tsx`, Settings → Backup; endpoints
  under `/api/settings/backup`, admin) — one zip per run (`VACUUM INTO`
  database snapshot, uploads, attachments, branding, and *offloaded bodies
  fetched back from providers* so the archive stands alone; git clones never)
  uploaded to one or more storage providers with per-target outcomes recorded
  in `backup_run`, pruned to `keepLast` per provider, scheduled by deriving
  "due" from the newest row rather than timer state. Restore copies the
  archive's database into the live connection with SQLite's online backup API
  (no file swap, no stale WAL) behind the maintenance gate (every `/api` call
  except status/health answers 503 until done), re-runs migrations, keeps
  sessions for accounts that still exist, inlines the captured offloaded
  bodies (`content_ref` cleared — re-assign shelf storage to offload again),
  replaces the included directories, marks repos whose clone is missing, and
  invalidates every settings cache (`Invalidate()` on RBA/API-key/branding,
  `ContentStoreRouter.Clear()`). The backup's own run row is written only once
  its archive exists, so a snapshot never carries a phantom "running" row.
  Scratch space: `BeeDocs:BackupWorkPath` (default `data/backup-work`); the
  newest `pre-restore-*.db` safety copy is kept there. See
  `Docs/BACKUP-RESTORE.md`.
- **SQLite** is file-backed by default (`data/sqlite/beedocs.db` under the API
  content root, directory configurable via `BeeDocs:DataPath`, or a full
  `ConnectionStrings:Sqlite`). There is no separate DB server.
- **Search** is SQLite FTS5 over a `search_doc` projection built by
  `SearchIndexService`, which is also where Markdown is reduced to indexable text
  (diagram JSON contributes only its shape labels, and uploaded documents are run
  through `AttachmentTextExtractor` so a PDF or .docx is searchable by its
  contents). Nothing calls the indexer to
  register a write: triggers on `page`/`diagram`/`slide_deck`/`kanban_board`/`project_plan`/`note`/`attachment`/`book`/
  `chapter`/`shelf` record changes in `search_queue`, and the queue is drained at
  startup and before each search,
  so the index stays correct whoever wrote the row — UI, MCP, import, or direct
  SQL. Exposed at `/api/search`, `/api/v1/search`, and the `beedocs_search` MCP
  tool; the UI opens it with Ctrl+K (`SearchPalette.tsx`).
- **Uploaded images** are served from `BeeDocs:UploadsPath` (default
  `data/uploads`) at `/uploads/*`, separate from the SQLite data dir so
  container deployments can point both at the same persistent volume. Book
  attachments are a *third* directory (`BeeDocs:AttachmentsPath`) and are never
  served statically — see the attachments bullet below for why.
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
- **Kanban boards** (`kanban_board` table, same storage shape as `diagram` /
  `slide_deck`): ordered columns of cards in one JSON document. The schema's
  source of truth is `src/beedocs-web/src/kanban/kanbanModel.ts` — the server
  stores it verbatim and reads only titles/bodies (search) and the card count
  (tree badge). A board is a book-tree item at `/books/{bookId}/kanban/{id}`
  (`KanbanCanvas.tsx`) and/or a page embed: inline ` ```kanban ` (JSON on the
  page) or ` ```kanban-ref ` (the board id; editing the embed updates the stored
  item). v1: add/rename/delete columns and cards, drag cards and columns,
  optional card colour, WIP limit, and an assignee from the user directory. Agents use
  `beedocs_create_kanban_board_with_columns` /
  `beedocs_update_kanban_board_columns`. See `Docs/KANBAN.md`.
- **Project plans** (`project_plan` table, same storage shape as `diagram` /
  `slide_deck` / `kanban_board`): a WBS of tasks and milestones plus a Gantt
  chart, one JSON document. The schema's source of truth is
  `src/beedocs-web/src/project/projectModel.ts` — the server stores it verbatim
  and reads only titles/assignee names (search) and the task count (tree badge).
  A plan is a book-tree item at `/books/{bookId}/project/{id}`
  (`ProjectCanvas.tsx`) and/or a page embed: inline ` ```project ` (JSON on the
  page) or ` ```project-ref ` (the plan id; editing the embed updates the stored
  item). v1: WBS table + custom Gantt, indent/outdent, drag bars to move and
  edges to resize, FS predecessors, optional assignee. Agents use
  `beedocs_create_project_plan_with_tasks` /
  `beedocs_update_project_plan_tasks`. See `Docs/PROJECT.md`.
- **Notes** (`note` table, same storage shape as `diagram` / `slide_deck` /
  `kanban_board` / `project_plan`) are OneNote-style pages: a free-form canvas
  of absolutely positioned blocks — Markdown text (with OneNote-like tags),
  checklists, images, and pen/highlighter **ink** — in one JSON document whose
  source of truth is `src/beedocs-web/src/notes/noteModel.ts`; the server
  stores it verbatim and reads only block texts (search) and the block count
  (tree badge). The OneNote hierarchy maps onto what exists: book = notebook,
  chapter = section, note = page. The signature gesture is *click anywhere on
  empty page → a text block appears there and takes focus*; an empty text block
  disappears on blur. Ink strokes carry **page** coordinates (an ink block's
  `x/y/w/h` is the derived bounding box), so drawing never re-bases points and
  moving ink is a translation; strokes drawn while one tool stays selected join
  one ink block, and the eraser removes whole strokes. The editor
  (`notes/NoteEditor.tsx`) keeps its own undo history over serialized sources
  and renders text blocks with `react-markdown` directly — not `MarkdownView`,
  which would be an import cycle since `MarkdownView` embeds notes. A note is a
  book-tree item at `/books/{bookId}/notes/{id}` (`NoteCanvas.tsx`) and/or a
  page embed: inline ` ```note ` or ` ```note-ref `. PDF export goes through
  `noteToHtml` (positioned HTML + SVG ink). Agents use
  `beedocs_create_note_with_blocks` / `beedocs_update_note_blocks` (text,
  checklist and image blocks, auto-stacked when no coordinates are given).
  See `Docs/NOTES.md`.
- **Attachments** are another thing a book holds (`attachment` table,
  `Services/AttachmentService.cs`, `components/AttachmentCanvas.tsx`, route
  `/books/{bookId}/files/{id}`): an uploaded PDF, Word/PowerPoint/Excel or
  OpenDocument file, archive or image that BeeDocs stores rather than authors.
  The one structural difference from pages/diagrams/decks is that **the payload
  is opaque bytes on disk, not text in SQLite** — so there is no `content_ref`
  column and no `ContentResolver` here, because a storage provider offloads
  bodies of text and a binary is not one. Files live under
  `BeeDocs:AttachmentsPath` (default `data/attachments`) named
  `{attachmentId}{ext}`, never a name the uploader chose; the original is kept
  in `file_name` and is what a download is served as. That directory is
  deliberately *not* inside `BeeDocs:UploadsPath`: static-file middleware serves
  `/uploads` and opens GET to anonymous readers whenever a shelf is published,
  whereas attachments are reachable only through
  `GET /api/attachments/{id}/download` and stay behind the `/api` gate. Uploads
  are gated by an **extension** allow-list (`AttachmentService.AllowedTypes`,
  100 MB cap) and the stored content type is derived from that extension —
  browsers spoof and omit content types, and the extension is what was actually
  checked. `POST /api/attachments/{id}/file` replaces the bytes keeping the id,
  so links survive a new version; `PUT` follows the `UpdateBookRequest`
  convention (null leaves alone, `""` clears). **Search reads inside the
  documents**: `AttachmentTextExtractor` pulls text from PDF (PdfPig — the one
  added package, Apache-2.0), OOXML and OpenDocument (zip + `XmlReader`, BCL
  only), RTF, plain text/XML, and zip entry names, running on the index drain in
  the same no-transaction phase as a provider fetch. It never throws — a corrupt
  or encrypted file degrades to metadata-only — skips files over 32 MB and caps
  extracted text at 256 KB, because the drain runs *before a search*.
  `AttachmentTextVersion` vs `app_setting['search.attachmentTextVersion']`
  requeues every attachment when the extractor improves, which Reconcile cannot
  spot on its own (it compares `updated_at`, and the document has not changed).
  `media/attachments.ts`
  in the web app mirrors the extension list and size cap so the picker can
  filter and a too-large file is refused before upload; the server list is the
  one that decides. Deleting a book cascades rows in the transaction and files
  after the commit. **Drag-and-drop** (`hooks/useFileDropZone.ts`,
  `hooks/useLibraryFileDrop.ts`, `hooks/useAttachmentUpload.ts`): dropping files
  anywhere under a book — tree node or overview — classifies them
  (`media/fileDropIntent.ts`): PDF, zip and images go to Files; Markdown asks
  whether to attach or become a page (and in which book). The toolbar/picker
  “Upload file” path still always files as an attachment. Dropping an image on
  a page embeds it (`useImageIntake` / `/api/uploads`). Dropping on an
  attachment's canvas replaces that file. Every target checks `dragHasFiles` first, because the
  tree's own drags carry JSON on `text/plain` and would otherwise read a dropped
  PDF as a page move; the tree's rows *decline* file drags (returning before
  `stopPropagation`) so the book-wide zone around them gets the event.
  `WorkspaceShell` cancels file drops at the window so a miss is swallowed
  rather than navigating the browser away from unsaved work. **MCP**
  (`BeeDocs.Mcp/Tools/AttachmentTools.cs`) exposes eight tools; the two shaped by
  the medium are `beedocs_read_attachment` (text for text formats, base64
  otherwise, and a refusal above 8 MB — base64 of a 100 MB PDF is ~133 MB of
  context) and `beedocs_link_attachment_in_page`. See `Docs/ATTACHMENTS.md`.
- **Favorites** (`favorite` table, `Services/FavoriteService.cs`, UI
  `FavoritesPanel.tsx` above the tree in the left pane) — per-user starred items
  (kinds `book | page | diagram | slides | kanban | project | note | attachment`, the search queue's
  names), keyed `(user_id, kind, entity_id)` with `user_id = ''` when sign-in is
  off or the caller is the API key — one shared list for an open instance, the
  same degradation ownership follows. `GET /api/favorites` returns the list
  hydrated with live titles and owning book; `PUT`/`DELETE
  /api/favorites/{kind}/{id}` star/unstar (PUT idempotent, 404 on a missing
  target). Both write verbs carry `RequireRole(Viewer)` — favoriting is a
  personal preference, not a content write, so read-only accounts may star.
  Deleted targets (and deleted accounts) are cleaned by `AFTER DELETE` triggers
  in `DatabaseInitializer`, search-queue-style, so every writer is covered.
  UI entry points: "Add/Remove from favorites" in the tree context menus;
  the panel (which renders nothing while empty, and collapses via
  `beedocs-favorites-collapsed` in localStorage) opens and unstars.
- **Privacy** — `is_private` on shelf, book, page, diagram, slide_deck,
  kanban_board, project_plan, note and attachment. The owner (or an admin) flips
  it via the ordinary update (`isPrivate`, null leaves it). A private item is
  hidden from every signed-in account except its owner; admins and the API key
  still see it; sign-in off does not filter. Direct URLs 404. Privacy inherits
  down (private shelf hides its books, private book hides its pages). Requires
  an owner; clearing the owner drops the flag. A private shelf cannot be
  published. The public bookshelf never includes private items. Search, favorites
  and export go through the same filter. Deleting an account un-privates what it
  owned.
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
- **RBA sign-in** (`Services/RbaAuthService.cs` + `RbaSettingsService.cs` +
  `RbaOptions.cs`, UI `RbaPanel.tsx`) — a switchable login provider delegating
  `POST /api/auth/login` to the central RBA service (application code `DOC`).
  Toggled at runtime from Settings → Sign-in provider: settings live in
  `app_setting` (`rba.settings`, admin-only `GET/PUT/DELETE /api/settings/rba`
  plus `POST …/test`), win over the `BeeDocs:Rba` config fallback, and apply to
  the next login — the admin's own session survives the switch, which is the
  way back from a misconfiguration. The connection is client-side: the browser
  posts credentials directly to RBA (`rbaBaseUrl` from `/api/auth/me`; RBA's
  `CorsUrls` must list the BeeDocs origin) and hands only the RS256 JWT to
  `POST /api/auth/rba`, where `RbaTokenValidator` (hand-rolled BCL, no
  IdentityModel dependency) verifies it against RBA's JWKS — the signature
  check is load-bearing because RBA itself doesn't verify its self-issued
  tokens on lookup. DOC roles are not claims in the token, so the server then
  fetches the `MultiAuthuser` from RBA via the `adfsToken` variant and maps
  groups/actions to admin/editor/viewer (`_ADMIN`/`_EDITOR` group suffix,
  `DOC_USER_MANAGE`, or any `*_WRITE` action);
  `IUserService.ProvisionExternalUserAsync` upserts an ordinary `app_user` row
  with an unusable random password — sessions, filters and the MCP API key
  stay exactly as in local mode. In RBA mode setup answers 409, roles re-sync
  each login unless `SyncRoles` is off, and a locally disabled account still
  blocks a valid RBA login. Local (integrated) accounts remain a sign-in path
  as deliberate break-glass — the login dialog offers a method switch, and
  `/api/auth/login` checks local credentials *before* forwarding to RBA, so an
  unreachable RBA (e.g. on-prem service, Azure-hosted BeeDocs) cannot lock the
  local admin out; `/api/auth/password` stays open because the current-password
  check already makes it unusable for RBA-provisioned accounts. `AuthStateDto.RbaEnabled`
  drives the UI copy. RBA-side records: `scripts/rba/create-rba-doc-data.sql`.
  **Offline mode** (`RbaSettings.Offline` + pasted `Jwks`) covers a cloud-hosted
  API with no route to on-prem RBA: browsers still sign in against RBA, the
  server verifies tokens against the pinned JWKS (public material, pasted in
  settings — the panel can fetch it via the admin's browser) and never dials
  out; the role lookup is skipped, so new accounts land as viewer, roles are
  managed on the Users page, and `SyncRoles` is forced off so a login never
  demotes a promoted account. `RbaTokenValidator` logs every rejection reason,
  and "no key to verify against" maps to 503 Unavailable, never 401.
  See `Docs/RBA-INTEGRATION.md`.
- **LLM writing help** (`/api/llm`, `Services/LlmProviderService.cs` +
  `LlmClient.cs`, `components/AiAssist.tsx` + `hooks/useLlmAssist.ts`) — inline
  autocomplete and selection actions (rewrite / grammar / format / summarize) in
  the page editor. OpenRouter, xAI, OpenAI, Cerebras and LM Studio all speak the
  OpenAI chat-completions API, so one client covers them; providers are rows in
  `llm_provider` and the key column is read only by `ResolveAsync`, never put in
  a DTO. Every call is proxied by the API so no key reaches the browser. Two
  more kinds, `claude-cli` and `grok-cli` (`Services/LlmCli.cs`), spawn the
  locally installed `claude`/`grok` command instead of calling an endpoint — no
  key, no base URL, and a blank model means the CLI's own default — for local
  installs where Claude Code or Grok CLI is already signed in; the command must
  be on the API process's PATH, so they don't work in a hosted container.
  `/api/llm` is behind the same `ApiKeyEndpointFilter` as `/api/v1`. With no
  key, `/api/v1` is closed unless an admin opts into anonymous publish; signed-in
  sessions still reach `/api/llm`. Setting a key does not lock the UI — a session
  is accepted in place of the machine header, so Settings → AI providers and
  writing help keep working. Auth-off instances with a key set are the remaining
  lockout (the browser has nowhere to keep the secret). See
  `Docs/LLM-PROVIDERS.md`.
- **Branding & themes** (`Services/BrandingService.cs`; UI `branding.tsx` +
  `components/BrandingPanel.tsx`, theme layer `theme.tsx` + `omarchyTheme.ts`)
  — an admin can rename the instance and replace the 🐝 mark. The title lives in
  `app_setting` (`branding.settings`, RbaSettingsService-style cached), the logo
  is a single file under `BeeDocs:BrandingPath` (default `data/branding`) —
  deliberately *not* under uploads, because the login screen must show it and
  `/uploads` is only anonymous while a shelf is published. Reads are anonymous
  (`GET /api/branding`, `GET /api/branding/logo?v=N` — the version cache-busts);
  every write is admin under `/api/settings/branding`. "Generate with AI" is the
  `logo` task in `LlmPrompts` through the default LLM provider: the endpoint
  returns a *preview* and nothing is stored until the admin applies it — and
  because the logo is served to everyone and the SVG is model output,
  `SanitizeSvg` (no scripts/handlers/external refs, lone `<svg>` only) gates
  both the generated and the uploaded path. Client side, `BrandingProvider`
  (inside ThemeProvider, outside the router — the login screen consumes it)
  fetches once, sets `document.title`/favicon, and feeds the **Omarchy desktop
  palette** into the theme layer: the server reads
  `~/.local/state/omarchy/current/theme/colors.toml` (older Omarchy:
  `~/.config/omarchy/current/theme/alacritty.toml`) and ships raw colors;
  `deriveOmarchyVars` computes the full token set, applied as inline CSS custom
  properties under `data-theme='omarchy'` — the one theme not declared in
  index.css, offered in the settings grid only when the palette exists, and
  auto-adopted only for a browser that never chose a theme
  (`storedThemeAtBoot`). The static theme list grew to 13
  (`nord`/`gruvbox`/`catppuccin`/`tokyo-night`/`rose-pine`/`solarized-light`
  added); each is one variable block in index.css plus a swatch rule and a
  `THEMES` row. See `Docs/BRANDING.md`.
- **UI languages** (`src/i18n/` — `index.tsx` provider + `useI18n()`,
  `langs.ts`, per-feature dictionaries in `messages/*.ts`) — the web UI ships
  in en/fr/de/es/nl/ja/zh, hand-rolled like theme.tsx (no i18n library).
  Per-browser choice (`beedocs-lang`, picker in Settings → Appearance),
  `navigator.languages` on first visit, English as runtime fallback. The
  completeness check is the type system: each messages file types its six
  non-English dictionaries as `Record<keyof typeof en, string>`, so a missing
  translation is a compile error in the file that owns the key. `common.ts` is
  the shared verb/noun glossary every namespace reuses; content, server
  messages, catalog shape names (serialized for MCP) and exported-document
  chrome deliberately stay untranslated. See `Docs/I18N.md`.
- **Git integration** (`/api/git`, `Services/GitCli.cs` + `GitConnectionService.cs`
  + `GitRepoService.cs` + `GitProviderCatalog.cs` + `GitSearchIndexer.cs`; UI
  `GitConnections.tsx`, `GitTree.tsx`, `GitCanvas.tsx`, routes `/git/:repoId[/files/*]`)
  — repos browsed like books on a shelf. The load-bearing decision: repo content
  is **never imported into entities** — each added repo is a server-side clone
  under `BeeDocs:GitPath` (default `data/git/{repoId}`) read live, and SQLite
  holds only `git_connection` (kinds `github | azure-devops | git`, PAT
  write-only) and `git_repo` (status `cloning|ready|error`; add clones in the
  background). `GitCli` is the one place git is spawned (ArgumentList only,
  token via `GIT_CONFIG_*` env never argv, hooks disabled, no file://
  remotes/submodules, per-repo mutation lock); `GitPaths` jails every client
  path (no `..`/absolute/`.git`/symlink hops). Opt-in per-repo search
  (`git_repo.indexed`): `GitSearchIndexer` rebuilds `search_doc` rows of kind
  `gitfile` (`{repoId}:{path}`) directly on each sync/commit/checkout — never
  via `search_queue`, whose drain reads unknown kinds as deletes. Editing:
  save ≠ commit — `PUT …/file` writes the working tree guarded by
  `baseBlobSha` (stale = 409 `GitConflictException`, the "caller's picture is
  stale" class that also covers push-behind-remote, conflicted pull — backed
  out with `merge --abort`, never left half-merged — and dirty checkout);
  Commit authors as the signed-in user via the self-chosen `app_user.git_email`
  (`POST /api/auth/git-email`; commits refused until set, committer is
  `BeeDocs`), Push never forces, and the one checkout per repo is shared
  instance state, honestly enforced (`?strategy=ours|theirs` on pull is the
  conflict answer). History/diff arrived with phase 3: `log` (rename-following
  per path), `commits/{sha}` patches, working-tree `diff` (untracked included
  per-path), `file?ref=` reads via plumbing (refs charset-validated, no
  leading `-`, no `..`), and working-tree delete/rename. Sixteen
  `beedocs_git_*` MCP tools (`BeeDocs.Mcp/Tools/GitTools.cs`) cover reads *and*
  writes — descriptions teach agents the safe flow (branch → write → commit
  only your paths → push → PR), and `GitCommitRequest.AuthorName/Email` let a
  machine caller name who it acts for (ignored for signed-in people). Pull's
  merge commits are pinned to the BeeDocs identity; `BeeDocs:GitFetchMinutes`
  (default 0) arms a background fetch that keeps behind-badges honest without
  touching the working tree; the toolbar deep-links PR creation on
  GitHub/DevOps. Per-user worktrees and the HybridPageEditor-over-git source
  are deliberately deferred (see the plan's log for why). AI actions on the
  repo context menu (`GitAssistService` + `GitAssistDialog.tsx`, POST
  `…/assist`, editor-gated) draft README/docs/manual/summary grounded in a
  server-built repo bundle (≤40 KB, most-informative-first) through the
  configured LLM provider via the `docdraft` task in `LlmPrompts` (own 240s
  budget); a reviewed draft can be saved into the repo *or* added as a page
  in an existing/new library book (`POST …/assist/publish`). A **documentation
  book** (`kind: book`) is always a background job: outline JSON then one
  completion per page (5–8), published as a multi-page book. The outline call
  uses JSON mode with thinking off so Cerebras Qwen does not return an empty
  or non-JSON plan. The same
  generation also runs as a **background job** (`GitAssistJobService`,
  POST `…/assist/jobs`, rows in `git_assist_job`, status
  queued→running→completed|failed). The header **✨ AI documentation jobs**
  button lists every job on the instance (badge while anything is running);
  `GitAssistJobs.tsx` on the repo front page lists that repo's jobs. Both
  poll the shared store while a job is active. The Markdown is stored on the row
  *before* publishing so a publish failure never costs the generation,
  restart-orphaned jobs are swept to failed at startup, and deleting a
  running job cancels it. A job can publish its result into the library as a
  book page or a multi-page book (existing book, or a new one on a chosen
  shelf; same titles update in place), and `…/jobs/{id}/rerun` copies
  parameters *and* page linkage so regenerated docs land on the same page(s)
  as a new revision. `AmbientActor`
  (`CurrentUserAccessor.cs`) carries the queuing user into the background
  task so page history names them. See `Docs/GIT-INTEGRATION.md`.
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
- `Docs/KANBAN.md` — kanban boards: document format, page embed, book-tree item.
- `Docs/PROJECT.md` — project plans: WBS + Gantt, page embed, book-tree item.
- `Docs/NOTES.md` — notes: OneNote-style free-form pages (text, checklists, images, ink), page embed, book-tree item.
- `Docs/ATTACHMENTS.md` — book attachments: storage, upload rules, and why they are not uploads.
- `Docs/GIT-INTEGRATION.md` — git/DevOps repos browsed as books; clones, security, search.
- `Docs/USERS-AND-ROLES.md` — accounts, roles, sessions, and the opt-in sign-in wall.
- `Docs/RBA-INTEGRATION.md` — delegating sign-in to the central RBA service (application DOC).
- `Docs/LLM-PROVIDERS.md` — LLM providers, key storage, and the `/api/llm` security trade-off.
- `Docs/BACKUP-RESTORE.md` — whole-instance backups to storage providers (incl. S3-compatible), scheduling, and the restore sequence.
- `Docs/BRANDING.md` — instance title/logo, AI logo generation, themes, the Omarchy desktop theme.
- `Docs/I18N.md` — the seven UI languages, the typed message-dictionary layer, glossary rules.
- `Vibecoding/Instructions.md` — product goals/vision behind the MVP.

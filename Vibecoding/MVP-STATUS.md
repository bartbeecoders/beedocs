# BeeDocs MVP — implementation status

Started from `Instructions.md`. Scaffolded and verified.

## Done

- Solution layout: `BeeDocs.slnx`, `src/BeeDocs.Api`, `src/beedocs-web`
- SurrealDB **embedded RocksDB** (`SurrealDb.Embedded.RocksDb`) + schema bootstrap
- Domain: Book, Chapter, Page, PageRevision, Diagram
- REST: books / pages / chapters CRUD; page revisions on update
- React UI: home (books), book pages list, Markdown editor with edit/split/preview
- Mermaid rendering (fenced ` ```mermaid ` blocks)
- Dark/light theme, responsive layout
- Docker/Podman: `Dockerfile` + `compose.yml`
- README with C4-style architecture + next steps

## Verified locally

```text
POST /api/books → id + slug
POST /api/books/{id}/pages → page with bookId
GET  /api/books/{id}/pages → list
PUT  /api/pages/{id} → version++
```

## How to run

```bash
# terminal 1
cd src/BeeDocs.Api && dotnet run

# terminal 2 (Node 22+)
cd src/beedocs-web && pnpm install && pnpm dev
```

Open http://localhost:5173

## Done (iteration)

- **Custom BeeDiagram editor** + full Diagram CRUD (API + UI)
  - Canvas: place nodes (box/person/system/db/note), drag, connect, properties
  - Embed via ` ```beediagram-ref` / ` ```beediagram` in Markdown pages

## Suggested next vibe prompts

1. Wire SPA static hosting in API (already partially in Program.cs) and smoke-test compose.
2. Full-text search.
3. Revisions UI + diffs.
4. Auth (public read / team edit / admin).
5. Hardware inventory page templates (BOM, rack, network).
6. Export PDF/MD/HTML.

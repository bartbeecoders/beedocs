# BeeDocs architecture (brief)

```text
┌──────────────────────────────────────────────────────────┐
│ UI (React + Vite)          http://localhost:5173         │
│  Workspace: library tree · page canvas · properties      │
└────────────────────────────┬─────────────────────────────┘
                             │ /api proxy
┌────────────────────────────▼─────────────────────────────┐
│ BeeDocs.Api (.NET 10)      http://localhost:5080         │
│  /api/*     UI CRUD (id-based)                           │
│  /api/v1/*  External publish API (slug-based books/pages)│
│  /api/auth  Sign-in · /api/users  accounts (admin only)  │
│  Books & pages carry an owner; pages keep a change log   │
│  SQLite (file under data/sqlite/beedocs.db)              │
└───────┬────────────────────▲─────────────────────────────┘
        │                    │ HTTP
        │                    │
┌───────▼────────┐  ┌────────┴─────────────────────────────────┐
│ Other apps     │  │ BeeDocs.Mcp (.NET MCP server)            │
│ PUT /api/v1/…  │  │ Tools / resources / prompts for agents   │
└────────────────┘  └──────────────────────────────────────────┘
```

The content hierarchy is **Shelf → Book → Folder (chapter) → Page**. Only the
book level is mandatory: a book sits on at most one shelf, and a book with no
shelf sits at the library root, which is where every book was before shelves
existed. A shelf holds no content of its own, so deleting one returns its books
to the root rather than cascading into them.

A shelf can also be served as a standalone website at
`/bookshelf-serve/{slug}` — a reader-only UI over that shelf's books and
pages, backed by `/api/bookshelf-serve/{name}`. `shelf.published` makes that
site world-readable when sign-in is on.

Besides pages, a book also holds **diagrams** (BeeDiagram/Mermaid documents) and
**slide decks** (PowerPoint-style presentations with a designer and a
full-screen presentation mode — see [SLIDES.md](./SLIDES.md)).

Every request through `/api` (and `/uploads`) passes one endpoint filter that
resolves the caller — a session cookie, the shared `BeeDocs:ApiKey` for machines,
or nobody — and checks its role. The filter is inert until
`BeeDocs:Auth:Enabled` is set, so the default deployment behaves exactly as it
did before accounts existed.

See product goals in `Vibecoding/Instructions.md`, the publish API in
[REST-API.md](./REST-API.md), MCP setup in [MCP-SERVER.md](./MCP-SERVER.md), and
accounts in [USERS-AND-ROLES.md](./USERS-AND-ROLES.md).

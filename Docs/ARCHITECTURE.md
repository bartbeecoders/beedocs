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

Every request through `/api` (and `/uploads`) passes one endpoint filter that
resolves the caller — a session cookie, the shared `BeeDocs:ApiKey` for machines,
or nobody — and checks its role. The filter is inert until
`BeeDocs:Auth:Enabled` is set, so the default deployment behaves exactly as it
did before accounts existed.

See product goals in `Vibecoding/Instructions.md`, the publish API in
[REST-API.md](./REST-API.md), MCP setup in [MCP-SERVER.md](./MCP-SERVER.md), and
accounts in [USERS-AND-ROLES.md](./USERS-AND-ROLES.md).

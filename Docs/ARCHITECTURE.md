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
│  SQLite (file under data/sqlite/beedocs.db)              │
└───────┬────────────────────▲─────────────────────────────┘
        │                    │ HTTP
        │                    │
┌───────▼────────┐  ┌────────┴─────────────────────────────────┐
│ Other apps     │  │ beedocs-mcp (Node MCP server)            │
│ PUT /api/v1/…  │  │ Tools / resources / prompts for agents   │
└────────────────┘  └──────────────────────────────────────────┘
```

See product goals in `Vibecoding/Instructions.md`, the publish API in
[REST-API.md](./REST-API.md), and MCP setup in [MCP-SERVER.md](./MCP-SERVER.md).

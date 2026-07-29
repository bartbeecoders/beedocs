# BeeDocs architecture (brief)

```text
┌──────────────────────────────────────────────────────────┐
│ UI (React + Vite)          http://localhost:5173         │
│  Workspace: library tree · page canvas · properties      │
└────────────────────────────┬─────────────────────────────┘
                             │ /api proxy
┌────────────────────────────▼─────────────────────────────┐
│ BeeDocs.Api (.NET 10)      http://localhost:5080         │
│  Books · Chapters · Pages · Diagrams                     │
│  SurrealDB embedded (RocksDB under data/surreal)         │
└────────────────────────────▲─────────────────────────────┘
                             │ HTTP
┌────────────────────────────┴─────────────────────────────┐
│ beedocs-mcp (Node MCP server, stdio)                     │
│  Tools / resources / prompts for AI agents               │
└──────────────────────────────────────────────────────────┘
```

See product goals in `Vibecoding/Instructions.md` and MCP setup in [MCP-SERVER.md](./MCP-SERVER.md).

# Windows deploy: MCP / Node issues (resolved)

## Previous failure (Node MCP)

Older Windows deploys ran MCP via Node (`mcp/dist/index.js`). An ancient
`node` on PATH crashed with:

```
SyntaxError: Unexpected token {
```

on ESM `import`, then `BeeDocs.Host` timed out waiting for `/healthz`.

## Current design

MCP is **`BeeDocs.Mcp`** (.NET 10, official C# MCP SDK). The Windows host
starts it with `dotnet BeeDocs.Mcp.dll` — same runtime as the API. **No Node
on the server.**

Rebuild/redeploy with:

```powershell
.\scripts\publish-windows.ps1 -UiPathBase /beedocs -ApiPathBase /beedocs-api -McpPathBase /beedocs-mcp
```

Server needs only the .NET 10 runtime.

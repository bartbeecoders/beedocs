# BeeDocs documentation

| Doc | Description |
|-----|-------------|
| [MCP Server](./MCP-SERVER.md) | Connect AI agents (Cursor, Claude Desktop, Claude Code, VS Code, etc.) to BeeDocs — over HTTP or stdio |
| [MCP Hosting](./MCP-HOSTING.md) | Running the MCP server on K3S and putting Cloudflare Access in front of it |
| [MCP Tools reference](./MCP-TOOLS.md) | Full list of tools, resources, and prompts |
| [Architecture](./ARCHITECTURE.md) | High-level product architecture |

Start the app with `./scripts/start.sh` — API on **5080**, UI on **5173**, MCP
over HTTP on **5090**. The MCP server talks to the **API**, not the Vite UI.

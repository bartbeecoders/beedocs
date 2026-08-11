# BeeDocs documentation

| Doc | Description |
|-----|-------------|
| [REST API](./REST-API.md) | External apps publishing books & Markdown pages (`/api/v1`) |
| [MCP Server](./MCP-SERVER.md) | Connect AI agents (Cursor, Claude Desktop, Claude Code, VS Code, etc.) to BeeDocs — over HTTP or stdio |
| [MCP Hosting](./MCP-HOSTING.md) | Running the MCP server on K3S and putting Cloudflare Access in front of it |
| [MCP Tools reference](./MCP-TOOLS.md) | Full list of tools, resources, and prompts |
| [Diagram Studio](./DIAGRAM-STUDIO.md) | The draw.io-style BeeDiagram editor — shapes, connections, shortcuts, JSON format |
| [Users & roles](./USERS-AND-ROLES.md) | Accounts, the admin/editor/viewer roles, and the opt-in sign-in wall |
| [LLM providers](./LLM-PROVIDERS.md) | Writing help in the editor — providers, where keys are stored, and why `/api/llm` needs protecting |
| [Export & import](./EXPORT-IMPORT.md) | Export books and documents to PDF, Markdown, Word or a re-importable archive — and import them back |
| [Architecture](./ARCHITECTURE.md) | High-level product architecture |

Start the app with `./scripts/start.sh` — API on **5080**, UI on **5173**, MCP
over HTTP on **5090**. The MCP server talks to the **API**, not the Vite UI.

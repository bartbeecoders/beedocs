# BeeDocs MCP — tools, resources, prompts

Server name: **`beedocs`** · Package: `src/BeeDocs.Mcp` (.NET; legacy Node under `src/beedocs-mcp`)

All tools return JSON text content (or an error message with `isError`).

---

## Tools

### System

| Tool | Description |
|------|-------------|
| `beedocs_health` | Ping API `/api/health` |
| `beedocs_get_api_info` | Base URL, entity model, embeds, capabilities, suggested workflow |

### Books

| Tool | Args | Description |
|------|------|-------------|
| `beedocs_list_books` | — | List all books |
| `beedocs_get_book` | `bookId` | Get book |
| `beedocs_create_book` | `title`, `description?`, `slug?` | Create book |
| `beedocs_update_book` | `bookId`, `title`, `description?`, `slug?`, `sortOrder?` | Update book |
| `beedocs_delete_book` | `bookId` | Delete book (+ cascade pages/chapters) |
| `beedocs_get_book_tree` | `bookId` | Folders + root pages + diagrams tree |
| `beedocs_export_book` | `bookId`, `includePageContent?`, `includeDiagramSource?` | Structured export of one book |

### Chapters (folders)

| Tool | Args | Description |
|------|------|-------------|
| `beedocs_list_chapters` | `bookId` | List folders |
| `beedocs_create_chapter` | `bookId`, `title`, `slug?`, `sortOrder?` | Create folder |
| `beedocs_update_chapter` | `chapterId`, `title`, `slug?`, `sortOrder?` | Rename / reorder folder |
| `beedocs_delete_chapter` | `chapterId` | Delete folder (pages move to book root) |

### Pages (Markdown documents)

| Tool | Args | Description |
|------|------|-------------|
| `beedocs_list_pages` | `bookId` | List page summaries |
| `beedocs_get_page` | `pageId` | Full page + content |
| `beedocs_create_page` | `bookId`, `title`, `content?`, `slug?`, `chapterId?`, `sortOrder?` | Create page (optionally in folder) |
| `beedocs_update_page` | `pageId`, `title`, `content?`, `slug?`, `chapterId?`, `sortOrder?` | Update (revision saved) |
| `beedocs_delete_page` | `pageId` | Delete page |
| `beedocs_append_page_content` | `pageId`, `markdown`, `separator?` | Append Markdown and save |
| `beedocs_move_page` | `pageId`, `chapterId?`, `clearFolder?`, `sortOrder?` | Move into/out of folder / reorder |

### Images

| Tool | Args | Description |
|------|------|-------------|
| `beedocs_upload_image` | `base64`, `fileName`, `contentType?` | Upload to `/uploads/…` |
| `beedocs_embed_image_in_page` | `pageId`, `url?` **or** `base64`+`fileName`, `alt?`, `heading?` | Upload (optional) + append `![alt](url)` |

### Diagrams

| Tool | Args | Description |
|------|------|-------------|
| `beedocs_list_diagrams` | `bookId` | List diagrams in book |
| `beedocs_list_page_diagrams` | `pageId` | Diagrams linked to page |
| `beedocs_get_diagram` | `diagramId` | Full diagram + source |
| `beedocs_create_diagram` | `bookId`, `title`, `kind?`, `source?`, `pageId?` | Create (`beediagram` \| `mermaid` \| `c4` \| `plantuml`) |
| `beedocs_update_diagram` | `diagramId`, `title`, `kind?`, `source?`, `pageId?` | Update diagram |
| `beedocs_delete_diagram` | `diagramId` | Delete diagram |
| `beedocs_create_beediagram_with_nodes` | `bookId`, `title`, `nodes[]`, `edges[]?`, `pageId?` | Structured BeeDiagram (nodes: box/person/system/db/note/**image**; edges: anchors, route, waypoints) |
| `beedocs_embed_diagram_in_page` | `pageId`, `diagramId`, `heading?` | Append embed fence to page |

### Library

| Tool | Args | Description |
|------|------|-------------|
| `beedocs_export_library_snapshot` | `includePageContent?`, `includeDiagramSource?` | Nested export of entire library |

### UI-only (not exposed via MCP)

| Feature | Reason |
|---------|--------|
| Browser **Export PDF** (print dialog) | Needs a browser; use UI or `beedocs_export_book` + external PDF pipeline |
| Drag-and-drop tree reorder | Agent uses `beedocs_move_page` / `beedocs_update_chapter` instead |
| Live canvas editing gestures | Agent sets BeeDiagram JSON via create/update tools |

---

## Resources

| URI template | Description |
|--------------|-------------|
| `beedocs://library` | All books JSON |
| `beedocs://books/{bookId}` | Book metadata |
| `beedocs://books/{bookId}/pages` | Page summaries |
| `beedocs://books/{bookId}/chapters` | Folder list |
| `beedocs://books/{bookId}/tree` | Folders + root pages + diagrams |
| `beedocs://pages/{pageId}` | Full page |
| `beedocs://diagrams/{diagramId}` | Full diagram |

---

## Rebuild MCP after changes

```bash
cd src/BeeDocs.Mcp && dotnet build
# restart the MCP process / Grok MCP connection
```

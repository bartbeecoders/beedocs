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

### Search

Start here when looking for content. Full-text search beats listing books and
reading pages one at a time, and it is the only way to find a page by what it
says rather than what it is called.

| Tool | Args | Description |
|------|------|-------------|
| `beedocs_search` | `query`, `limit?`, `offset?`, `bookId?`, `kinds?` | Search shelves, books, folders, pages, diagram labels and slide text/notes |
| `beedocs_search_status` | — | Engine, document counts by kind, queued changes |
| `beedocs_reindex` | — | Rebuild the index from stored documents (recovery only) |

Each hit carries `kind`, `id`, `title`, `bookId`/`bookTitle`, a `snippet` with
matched terms wrapped in `U+E000`/`U+E001`, and the workspace `url`. Follow a
page hit with `beedocs_get_page` to read the whole document.

Query syntax: terms are ANDed, `"quoted runs"` match as a phrase, and diacritics
fold (`cafe` finds `café`). Operators are not interpreted — any input is safe to
pass through verbatim.

### Shelves

The level above books: a shelf groups related books and holds no pages of its
own. A book sits on at most one shelf; a book with no shelf sits at the library
root. Deleting a shelf keeps every book on it — they return to the root.

| Tool | Args | Description |
|------|------|-------------|
| `beedocs_list_shelves` | — | List all shelves (with `bookCount`) |
| `beedocs_get_shelf` | `shelfId` | Get shelf |
| `beedocs_list_shelf_books` | `shelfId` | Books filed on one shelf |
| `beedocs_create_shelf` | `title`, `description?`, `slug?`, `published?` | Create shelf (optionally as a public website) |
| `beedocs_update_shelf` | `shelfId`, `title`, `description?`, `slug?`, `sortOrder?`, `published?` | Rename / reorder shelf, or publish it as `/bookshelf-serve/{slug}` |
| `beedocs_delete_shelf` | `shelfId` | Delete shelf (books kept, moved to library root) |
| `beedocs_move_book_to_shelf` | `bookId`, `shelfId?` | File a book on a shelf; omit `shelfId` to move it to the root |

### Books

| Tool | Args | Description |
|------|------|-------------|
| `beedocs_list_books` | — | List all books (each with `shelfId`/`shelfTitle` when shelved) |
| `beedocs_get_book` | `bookId` | Get book |
| `beedocs_create_book` | `title`, `description?`, `slug?`, `shelfId?` | Create book (optionally on a shelf) |
| `beedocs_update_book` | `bookId`, `title`, `description?`, `slug?`, `sortOrder?`, `shelfId?` | Update book (omitted fields are left alone; `shelfId: ""` unshelves) |
| `beedocs_delete_book` | `bookId` | Delete book (+ cascade pages/chapters) |
| `beedocs_get_book_tree` | `bookId` | Folders + root pages + diagrams + slide decks tree |
| `beedocs_export_book` | `bookId`, `includePageContent?`, `includeDiagramSource?`, `includeSlideSource?` | Structured export of one book |

### Chapters (folders)

| Tool | Args | Description |
|------|------|-------------|
| `beedocs_list_chapters` | `bookId` | List folders |
| `beedocs_create_chapter` | `bookId`, `title`, `slug?`, `sortOrder?` | Create folder |
| `beedocs_update_chapter` | `chapterId`, `title`, `slug?`, `sortOrder?`, `bookId?` | Rename / reorder folder, or move it to another book |
| `beedocs_move_chapter` | `chapterId`, `bookId`, `sortOrder?` | Move folder (and its pages) into another book |
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
| `beedocs_move_page` | `pageId`, `chapterId?`, `clearFolder?`, `sortOrder?`, `bookId?` | Move into/out of folder, into another book, or reorder |

### Images

| Tool | Args | Description |
|------|------|-------------|
| `beedocs_upload_image` | `base64`, `fileName`, `contentType?` | Upload to `/uploads/…` |
| `beedocs_embed_image_in_page` | `pageId`, `url?` **or** `base64`+`fileName`, `alt?`, `heading?` | Upload (optional) + append `![alt](url)` |

### Attachments (files filed in a book)

| Tool | Args | Description |
|------|------|-------------|
| `beedocs_list_attachments` | `bookId` | Metadata for every file in the book |
| `beedocs_get_attachment` | `attachmentId` | One file's title, description, owner, type, size |
| `beedocs_upload_attachment` | `bookId`, `base64`, `fileName`, `title?`, `description?` | File a document against a book |
| `beedocs_read_attachment` | `attachmentId` | Contents — `text` for text formats, `base64` otherwise |
| `beedocs_update_attachment` | `attachmentId`, `title`, `description?`, `ownerId?`, `fileName?` | Properties only; `""` clears, omit leaves alone |
| `beedocs_replace_attachment_file` | `attachmentId`, `base64`, `fileName` | New bytes, same id — links keep working |
| `beedocs_link_attachment_in_page` | `pageId`, `attachmentId`, `label?`, `heading?` | Append a Markdown link to the file |
| `beedocs_delete_attachment` | `attachmentId` | Delete row and stored file |

Accepted extensions: `.pdf .doc .docx .xls .xlsx .ppt .pptx .vsd .vsdx .odt .ods
.odp .txt .md .rtf .csv .json .xml .yaml .yml .zip .7z .tar .gz .png .jpg .jpeg
.gif .webp .svg` — max 100 MB. The **extension** decides, not the content type.

`beedocs_read_attachment` refuses files over 8 MB and returns the download URL
instead: base64 of a 100 MB PDF is ~133 MB of text pointed at a context window.
Text formats (TXT, MD, CSV, JSON, XML, YAML, SVG) come back as readable text.

Attachments vs. images: `beedocs_upload_image` is for pictures embedded in page
Markdown (`/uploads/…`, served statically); an attachment is a *document filed in
a book*, reachable only through the API and linked as
`[Title](/books/{bookId}/files/{attachmentId})`.

Attachment metadata also rides along in `beedocs_get_book_tree`,
`beedocs_export_book`, and the `beedocs://books/{bookId}/attachments` resource.

`beedocs_search` matches the **text inside** these documents, not just their
titles — PDF, Word, PowerPoint, Excel, OpenDocument, RTF, text formats and zip
entry names are all extracted into the index. So finding "the spec that mentions
the latch tolerance" is one search, not a download-and-read loop.

### Diagrams

| Tool | Args | Description |
|------|------|-------------|
| `beedocs_list_diagrams` | `bookId` | List diagrams in book |
| `beedocs_list_page_diagrams` | `pageId` | Diagrams linked to page |
| `beedocs_get_diagram` | `diagramId` | Full diagram + source |
| `beedocs_create_diagram` | `bookId`, `title`, `kind?`, `source?`, `pageId?` | Create (`beediagram` \| `isometric` \| `mermaid` \| `c4` \| `plantuml`) |
| `beedocs_update_diagram` | `diagramId`, `title`, `kind?`, `source?`, `pageId?` | Update diagram |
| `beedocs_delete_diagram` | `diagramId` | Delete diagram |
| `beedocs_list_diagram_shapes` | `section?`, `azureCategory?`, `query?` | The shape catalog: studio shapes, **Azure stencils**, palette groups, anchors, routes, arrow heads |
| `beedocs_create_beediagram_with_nodes` | `bookId`, `title`, `nodes[]`, `edges[]?`, `pageId?` | Structured BeeDiagram — full studio model (see below) |
| `beedocs_update_beediagram_nodes` | `diagramId`, `nodes[]`, `edges[]?`, `title?` | Replace an existing canvas with the same structured model |
| `beedocs_create_isometric_with_items` | `bookId`, `title`, `items[]`, `connectors[]?`, `zones[]?`, `texts[]?`, `pageId?` | Structured isometric diagram (see below) |
| `beedocs_update_isometric_items` | `diagramId`, `items[]`, `connectors[]?`, `zones[]?`, `texts[]?`, `title?` | Replace an isometric diagram with the same structured model |
| `beedocs_embed_diagram_in_page` | `pageId`, `diagramId`, `heading?` | Append embed fence to page |

#### Structured BeeDiagram nodes and edges

`beedocs_create_beediagram_with_nodes` and `beedocs_update_beediagram_nodes` take
the whole studio model, so an agent can build the same diagrams a human can:

| Node field | Notes |
|------------|-------|
| `type` | Classic look: `box` \| `person` \| `system` \| `database` \| `note` \| `image` |
| `shape` | Studio catalog shape (`rectangle`, `cylinder`, `hexagon`, `container`, `azure`, …). Wins over `type` |
| `icon` | Azure stencil id for `shape=azure` — `aks`, `app-service`, `sql-database`, `table-storage`, … Setting it implies `shape=azure` |
| `style` | `fill`, `fill2`, `stroke`, `strokeWidth`, `dashed`, `opacity`, `shadow`, `fontSize`, `fontColor`, `bold`, `italic`, `align`, `valign` |
| `parentId` | Id of a `shape=container` node this one sits in (coordinates stay absolute) |
| `rotation`, `x`/`y`, `w`/`h`, `color`, `imageUrl` | `w`/`h` default to the shape's natural size |

| Edge field | Notes |
|------------|-------|
| `fromAnchor` / `toAnchor` | `n\|e\|s\|w`, corners `ne\|se\|sw\|nw`, quarter points `n1\|n2\|e1\|e2\|s1\|s2\|w1\|w2`; omit to auto-pick |
| `route` | `straight` \| `curved` \| `orthogonal` |
| `waypoints` | `[{x,y}]` bends for orthogonal routes |
| `style` | `stroke`, `strokeWidth`, `dashed`, `startArrow`, `endArrow`, `fontSize`, `fontColor` |

Unknown shape / stencil / anchor / route / arrow-head values are rejected with an
error naming the valid ones, so a wrong guess costs one round trip.

Typical Azure flow: `beedocs_list_diagram_shapes` (`section="azure"`, plus
`azureCategory` or `query`) → `beedocs_create_beediagram_with_nodes` with
`shape="container"` boundary nodes and `shape="azure"` + `icon` service nodes
linked by `parentId` → `beedocs_embed_diagram_in_page`.

#### Structured isometric items

`beedocs_create_isometric_with_items` / `beedocs_update_isometric_items` build
`kind=isometric` diagrams — the tile-grid editor in 2:1 dimetric projection.
Items sit one per integer tile: `x` runs to the lower-right on screen, `y` to
the lower-left. Shape ids and the raw document schema are served by
`beedocs_get_api_info` under `isometric`.

| Item field | Notes |
|------------|-------|
| `shape` | `server`, `server-rack`, `vm`, `lambda`, `database`, `storage`, `queue`, `cache`, `cloud`, `globe`, `router`, `switch`, `firewall`, `load-balancer`, `user`, `users`, `building`, `laptop`, `desktop`, `mobile`, `lock`, `gear`, `block`, `platform` |
| `x` / `y` | Integer tile; omit both to auto-place on a spread grid |
| `label` | Rendered under the shape |
| `color` | Base `#hex`; the three face shades are derived from it |

| Other input | Fields |
|-------------|--------|
| `connectors[]` | `from`, `to` (item ids), `label?`, `color?`, `dashed?` — routed L-shaped between tiles, arrow at `to` |
| `zones[]` | `x1`, `y1`, `x2`, `y2` (inclusive tile rectangle), `label?`, `color?` — a tinted floor area behind the items |
| `texts[]` | `x`, `y`, `text` — free-standing labels |

Unknown shape ids and connectors naming missing items are rejected with an
error listing the valid values, so a wrong guess costs one round trip. Pages
embed the result with ```` ```isometric-ref\nDIAGRAM_ID\n``` ```` (also what
`beedocs_embed_diagram_in_page` emits for this kind).

### Slides

| Tool | Args | Description |
|------|------|-------------|
| `beedocs_list_slide_decks` | `bookId` | Deck summaries incl. `slideCount` |
| `beedocs_get_slide_deck` | `deckId` | Full deck + JSON document |
| `beedocs_create_slide_deck` | `bookId`, `title`, `source?`, `templateId?` | Raw JSON create; omit both for one blank slide, or start from a template |
| `beedocs_update_slide_deck` | `deckId`, `title?`, `source?` | Update title and/or document (null keeps current) |
| `beedocs_delete_slide_deck` | `deckId` | Delete deck |
| `beedocs_create_slide_deck_with_slides` | `bookId`, `title`, `slides[]`, `theme?` | Structured create — validated slides/elements |
| `beedocs_update_slide_deck_slides` | `deckId`, `slides[]`, `title?`, `theme?` | Replace slides with the same structured model |
| `beedocs_list_slide_templates` | — | App-wide reusable layouts with slide counts |
| `beedocs_save_slide_template` | `name`, `deckId?` **or** `source?` | Save a deck's layout (or a raw document) as a template |
| `beedocs_delete_slide_template` | `templateId` | Delete a template (existing decks unaffected) |
| `beedocs_export_slide_deck_pptx` | `deckId` | Base64 .pptx — opens in PowerPoint and imports into Google Slides |

#### Structured slides

Each slide is `{ id?, background?, notes?, elements[] }` on a 1280×720 canvas;
**element array order is z-order** (later draws on top). Elements:

| Element field | Notes |
|---------------|-------|
| `kind` | `text` (default) \| `shape` \| `image` |
| `x`/`y`, `w`/`h` | Slide coordinates; unplaced elements stack downwards |
| `text`, `fontSize`, `bold`, `italic`, `underline`, `align`, `valign`, `color` | Text content and styling — also the label inside a shape |
| `shape` | `rect` (default) \| `rounded` \| `ellipse` \| `triangle` \| `diamond` \| `star` \| `arrow` \| `line` |
| `fill`, `stroke`, `strokeWidth`, `opacity`, `rotation` | Shape appearance |
| `imageUrl` | Required for `kind=image` — an `/uploads/…` URL from `beedocs_upload_image` |

Deck-wide `theme` sets `background`, `color`, `accent`, `fontFamily`; slide
`notes` are speaker notes (indexed for search, never rendered). The full
document format is documented in [SLIDES.md](./SLIDES.md).

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
| `beedocs://books/{bookId}/attachments` | Attachment metadata (contents via `beedocs_read_attachment`) |
| `beedocs://books/{bookId}/tree` | Folders + root pages + diagrams + slide decks + attachments |
| `beedocs://pages/{pageId}` | Full page |
| `beedocs://diagram/catalog` | Every shape, Azure stencil, palette group, anchor, route and arrow head |
| `beedocs://diagrams/{diagramId}` | Full diagram |
| `beedocs://slides/{deckId}` | Full slide deck |

---

## Rebuild MCP after changes

```bash
cd src/BeeDocs.Mcp && dotnet build
# restart the MCP process / Grok MCP connection
```

The shape catalog served by `beedocs_list_diagram_shapes` and
`beedocs://diagram/catalog` is `src/BeeDocs.Mcp/diagram-catalog.json`, an
embedded resource generated from the studio TypeScript. Adding a shape or an
Azure stencil in `src/beedocs-web/src/diagram/` therefore needs no C# edit —
just regenerate and rebuild:

```bash
pnpm --dir src/beedocs-web gen:catalog   # also runs as part of `pnpm build`
cd src/BeeDocs.Mcp && dotnet build
```

`node scripts/gen-diagram-catalog.mjs --check` (from `src/beedocs-web`) exits
non-zero when the committed JSON has drifted from the TypeScript.

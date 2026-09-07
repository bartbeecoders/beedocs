# Notes (OneNote-style pages)

Notes bring Microsoft OneNote's way of working to a BeeDocs book: a free-form
page where you **click anywhere and start typing**, move blocks around, tick
off to-dos, paste pictures and draw with a pen or highlighter. The OneNote
hierarchy maps onto what BeeDocs already has, so nothing new was needed above
the page:

| OneNote | BeeDocs |
| --- | --- |
| Notebook | Book (on a shelf) |
| Section | Chapter / folder, or simply the book itself |
| Page | **Note** — a book-tree item at `/books/{bookId}/notes/{id}` |
| Section colour tabs | Page colour (per note) |
| Tags (Important, Question, Idea…) | Block tags |
| To Do tag | Checklist block |
| Ink | Pen / highlighter strokes, stroke-level eraser |
| Quick Notes | A note in any book, or a ` ```note ` block inside a page |

A note lives in a book next to pages, diagrams, slide decks, kanban boards and
project plans, stored as one JSON document. The same note can be a **tree
item** or **embedded on a page** — either as an inline ` ```note ` fence (JSON
lives on the page) or as ` ```note-ref ` (the body is the note id; editing the
embed updates the stored item).

## Where things live

| Piece | Location |
| --- | --- |
| Entity + DTOs | `src/BeeDocs.Api/Models/Entities.cs` (`Note`), `Models/Dtos.cs` |
| Service + endpoints | `Services/NoteService.cs`, mapped in `Program.cs` |
| Document schema | `src/beedocs-web/src/notes/noteModel.ts` (the one source of truth) |
| Editor | `src/beedocs-web/src/notes/NoteEditor.tsx` (canvas, toolbar, ink) |
| Read-only view | `src/beedocs-web/src/notes/NoteView.tsx` |
| Route canvas | `src/beedocs-web/src/components/NoteCanvas.tsx` (`/books/{bookId}/notes/{noteId}`) |
| Styles | `src/beedocs-web/src/styles/notes.css` |
| MCP tools | `src/BeeDocs.Mcp/Tools/NoteTools.cs` |

## REST endpoints

Same shape as diagrams — id-based, behind the standard `/api` auth filter:

```
GET    /api/books/{bookId}/notes   → NoteSummary[] (includes blockCount)
POST   /api/books/{bookId}/notes   { title, source? }   → Note
GET    /api/notes/{id}             → Note
PUT    /api/notes/{id}             { title, source? }   → Note (null source = leave unchanged)
DELETE /api/notes/{id}
```

Deleting a book cascades into its notes, like pages and diagrams. Bodies follow
the same `content_ref` offload as pages/diagrams/slide decks/kanban/project.

## Document format (`note.source`)

```jsonc
{
  "version": 1,
  "background": "plain",     // plain | ruled | grid | dots
  "paper": "white",          // white | cream | mint | sky | lavender | rose | graphite
  "blocks": [                // array order is z-order; later blocks draw on top
    {
      "id": "blk-…", "kind": "text",
      "x": 48, "y": 40, "w": 320, "h": null,     // CSS px on the page; h null = auto height
      "text": "# Heading\n\nMarkdown (GFM)",
      "tag": null                                 // important | question | idea | remember | critical | definition | contact
    },
    {
      "id": "blk-…", "kind": "checklist",
      "x": 48, "y": 200, "w": 280, "h": null,
      "title": "To do",
      "items": [{ "id": "chk-…", "text": "Agree next steps", "done": false }]
    },
    {
      "id": "blk-…", "kind": "image",
      "x": 400, "y": 40, "w": 320, "h": 200,
      "src": "/uploads/…", "alt": "diagram"
    },
    {
      "id": "blk-…", "kind": "ink",
      "x": 60, "y": 300, "w": 180, "h": 90,      // bounding box of the strokes (derived)
      "strokes": [
        { "id": "stk-…", "color": "#1f2933", "width": 3.5, "opacity": 1, "points": [x0, y0, x1, y1, "…"] }
      ]
    }
  ]
}
```

Ink strokes carry **page** coordinates, not block-relative ones: drawing never
has to re-base points when a stroke grows the block's box, and moving an ink
block simply translates its points. The API stores the document verbatim; the
server reads only block texts (search indexing) and the block count (the tree
badge), so new fields can be added in `noteModel.ts` without a server change.
`parseNote` is deliberately tolerant: missing fields take defaults, unknown
blocks are dropped, a broken document opens as an empty page.

## Editor (v1)

- **Click anywhere** on empty page → a new text block appears there and takes
  focus. A text block left empty disappears on blur, as in OneNote.
- Text blocks are Markdown: click to edit the source, click away to see it
  rendered. Headings, lists, task lists, emphasis, code and links all work.
- **Drag** a block by the bar that appears above it; drag its right edge to
  change width (images resize from the corner, keeping their aspect ratio).
- **Checklist** blocks: Enter adds an item, Backspace on an empty item removes
  it, the checkbox strikes it through.
- **Images**: toolbar button, paste from the clipboard, or drop a file on the
  page — uploaded through `/api/uploads` like page images.
- **Pen / highlighter / eraser**: strokes go into an ink block; every stroke
  drawn while the same tool stays selected joins that block, switching tools
  starts a new one. The eraser removes whole strokes (OneNote's default).
  In select mode a stroke can be dragged to move its whole ink block.
- **Tags** on a text block (★ Important, ? Question, 💡 Idea, 📌 Remember,
  ! Critical, § Definition, ☎ Contact) show as a glyph in the margin.
- **Page colour** and **rule lines** (plain / ruled / grid / dots) per note.
- Bring to front / send to back, Delete removes the selected block,
  Ctrl+Z / Ctrl+Shift+Z (or Ctrl+Y) undo and redo inside the editor.
  Esc leaves text editing, then returns to the select tool, then deselects.
- Viewers get the same page read-only, with no toolbar.

Compact mode (page embeds) keeps everything above inside a bounded, scrollable
frame with an icon-only toolbar.

## On a page

| Fence | Body | Stored where |
| --- | --- | --- |
| ` ```note ` | JSON document | On the page (like an inline BeeDiagram) |
| ` ```note-ref ` | Note id | Shared with the book-tree item |

Insert via **Add → Note** (inline) or **Add → Linked note** (creates the book
item and embeds it). The properties pane of a note shows the exact
` ```note-ref ` snippet with a copy button.

## Export

PDF export renders a note as positioned HTML (`noteToHtml` in `noteModel.ts`):
text blocks through a small Markdown→HTML pass, checklists as ☐/☑ lists,
images inline and ink as an SVG overlay, on the note's paper colour and rule
lines.

## MCP

`beedocs_create_note_with_blocks` / `beedocs_update_note_blocks` accept
structured text, checklist and image blocks and auto-stack them down the page
when no coordinates are given. Raw JSON goes through `beedocs_create_note` /
`beedocs_update_note`. Embed a stored note with:

````
```note-ref
NOTE_ID
```
````

See [MCP-TOOLS.md](./MCP-TOOLS.md).

## Search

Notes are indexed by the same trigger + queue pipeline as everything else
(`kind = 'note'`). Text block Markdown (reduced like a page body), checklist
titles and items, and image alt text are searchable; ink and geometry are not.
`note-ref` fences on a page do not re-index the note (the note's own row does).
Unknown `search_queue` kinds drain as deletes — keep `note` wired in
`SearchIndexService`.

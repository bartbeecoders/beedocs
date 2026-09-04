# Kanban boards

Kanban boards live in a book next to pages, diagrams and slide decks: ordered
columns of cards, stored as one JSON document. The same board can be a **tree
item** (`/books/{bookId}/kanban/{id}`) or **embedded on a page** — either as an
inline ` ```kanban ` fence (JSON lives on the page) or as ` ```kanban-ref `
(the body is the board id; editing the embed updates the stored item).

## Where things live

| Piece | Location |
| --- | --- |
| Entity + DTOs | `src/BeeDocs.Api/Models/Entities.cs` (`KanbanBoard`), `Models/Dtos.cs` |
| Service + endpoints | `Services/KanbanBoardService.cs`, mapped in `Program.cs` |
| Document schema | `src/beedocs-web/src/kanban/kanbanModel.ts` (the one source of truth) |
| Editor | `src/beedocs-web/src/kanban/KanbanBoard.tsx` |
| Read-only view | `src/beedocs-web/src/kanban/KanbanView.tsx` |
| Route canvas | `src/beedocs-web/src/components/KanbanCanvas.tsx` (`/books/{bookId}/kanban/{boardId}`) |

## REST endpoints

Same shape as diagrams — id-based, behind the standard `/api` auth filter:

```
GET    /api/books/{bookId}/kanban     → KanbanBoardSummary[] (includes cardCount)
POST   /api/books/{bookId}/kanban     { title, source? }   → KanbanBoard
GET    /api/kanban/{id}               → KanbanBoard
PUT    /api/kanban/{id}               { title, source? }   → KanbanBoard (null source = leave unchanged)
DELETE /api/kanban/{id}
```

Deleting a book cascades into its kanban boards, like pages and diagrams.
Bodies follow the same `content_ref` offload as pages/diagrams/slide decks.

## Document format (`kanban_board.source`)

```jsonc
{
  "version": 1,
  "columns": [
    {
      "id": "col-…",
      "title": "To do",
      "wip": 3,                         // optional work-in-progress limit; omit / null = none
      "cards": [
        {
          "id": "card-…",
          "title": "Write the brief",
          "body": "optional details",
          "color": "accent",            // accent|info|ok|warn|danger|muted, or null
          "assigneeId": "usr-…",        // optional account id
          "assigneeName": "Ada"         // optional name snapshot
        }
      ]
    }
  ]
}
```

The API stores the document verbatim; the server only reads column titles plus
card titles/bodies/assignee names (search indexing) and the card count (the tree
badge), so new fields can be added in `kanbanModel.ts` without a server change.
`parseBoard` is deliberately tolerant: missing fields take defaults, a broken
document opens as three empty columns.

## On a page

| Fence | Body | Stored where |
| --- | --- | --- |
| ` ```kanban ` | JSON document | On the page (like an inline BeeDiagram) |
| ` ```kanban-ref ` | Board id | Shared with the book-tree item |

Insert via **Add → Kanban** (inline) or **Add → Linked kanban** (creates the
book item and embeds it). Viewers get a read-only board; editors can drag cards
and columns, add/rename/delete, set a colour, an optional WIP limit, and assign
a user from the instance directory.

## MCP

`beedocs_create_kanban_board_with_columns` / `beedocs_update_kanban_board_columns`
accept structured columns and cards. Raw JSON goes through
`beedocs_create_kanban_board` / `beedocs_update_kanban_board`. Embed a stored
board with:

````
```kanban-ref
BOARD_ID
```
````

See [MCP-TOOLS.md](./MCP-TOOLS.md).

## Search

Boards are indexed by the same trigger + queue pipeline as everything else
(`kind = 'kanban'`). Column titles and card titles/bodies are searchable;
`kanban-ref` fences on a page do not re-index the board (the board's own row
does).

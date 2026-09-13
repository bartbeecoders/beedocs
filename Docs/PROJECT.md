# Project plans

Project plans live in a book next to pages, diagrams, slide decks and kanban
boards: a WBS of tasks and milestones with a Gantt chart, stored as one JSON
document. The same plan can be a **tree item** (`/books/{bookId}/project/{id}`)
or **embedded on a page** — either as an inline ` ```project ` fence (JSON
lives on the page) or as ` ```project-ref ` (the body is the plan id; editing
the embed updates the stored item).

## Where things live

| Piece | Location |
| --- | --- |
| Entity + DTOs | `src/BeeDocs.Api/Models/Entities.cs` (`ProjectPlan`), `Models/Dtos.cs` |
| Service + endpoints | `Services/ProjectPlanService.cs`, mapped in `Program.cs` |
| Document schema | `src/beedocs-web/src/project/projectModel.ts` (the one source of truth) |
| Editor | `src/beedocs-web/src/project/ProjectEditor.tsx` (WBS table + Gantt) |
| Read-only view | `src/beedocs-web/src/project/ProjectView.tsx` |
| Route canvas | `src/beedocs-web/src/components/ProjectCanvas.tsx` (`/books/{bookId}/project/{planId}`) |

## REST endpoints

Same shape as diagrams — id-based, behind the standard `/api` auth filter:

```
GET    /api/books/{bookId}/project   → ProjectPlanSummary[] (includes taskCount)
POST   /api/books/{bookId}/project   { title, source? }   → ProjectPlan
GET    /api/project/{id}             → ProjectPlan
PUT    /api/project/{id}             { title, source? }   → ProjectPlan (null source = leave unchanged)
DELETE /api/project/{id}
```

Deleting a book cascades into its project plans, like pages and diagrams.
Bodies follow the same `content_ref` offload as pages/diagrams/slide decks/kanban.

## Document format (`project_plan.source`)

```jsonc
{
  "version": 1,
  "tasks": [
    {
      "id": "task-…",
      "title": "Design",
      "kind": "task",                   // task | milestone
      "start": "2026-09-08",            // YYYY-MM-DD, or null = unscheduled
      "duration": 5,                    // calendar days; 0 for a milestone
      "progress": 0,                    // 0–100
      "parentId": null,                 // WBS indent; summaries are derived
      "predecessors": ["task-…"],       // finish-to-start task ids
      "assigneeId": "usr-…",            // optional account id
      "assigneeName": "Ada",            // optional name snapshot
      "color": "info"                   // accent|info|ok|warn|danger|muted, or null = theme accent
    }
  ],
  "layout": {                           // optional; absent = CSS defaults
    "table": 480,                       // px width of the WBS half of the split
    "columns": { "name": 220, "start": 110 },  // px per column: name|kind|start|duration|finish|progress|predecessors|assignee
    "scale": "weeks"                    // Gantt zoom: months|weeks|days|hours; absent = days
  }
}
```

Finish is inclusive: `start + duration − 1` for a task, `start` for a milestone.
Summary rows are not stored — a task with children rolls up start/finish/progress
from descendants. The API stores the document verbatim; the server only reads
titles plus assignee names (search indexing) and the task count (the tree
badge), so new fields can be added in `projectModel.ts` without a server change.
`parsePlan` is deliberately tolerant: missing fields take defaults, a broken
document opens as one empty task. `layout` is presentation the plan carries
with it so every reader sees the same table; widths are clamped on read
(columns 40–800 px, table 160–1600 px) and an empty `layout` is dropped on
write. `beedocs_update_project_plan_tasks` copies the stored `layout` across
when it replaces the tasks.

## Editor (v1)

Split view: left WBS table, right Gantt (custom SVG, no library).

- Indent / outdent (Tab / Shift+Tab, or the toolbar) nests under the previous
  sibling at the same depth.
- Alt+↑ / Alt+↓ moves a task and its descendants as a block.
- Drag a Gantt bar to shift dates; drag an edge to resize. Pointer-down takes a
  baseline snapshot so React re-renders do not double-apply the delta.
- Milestones are diamonds (`duration` 0). Finish-to-start links are curves from
  predecessor finish to successor start.
- Pred column: 1-based row numbers, comma-separated, like MS Project (`2,3`).
- Assignee via the instance user directory (hidden when there are no accounts,
  unless a task already has an assignee).
- **Colour**: the toolbar swatches (same six names as kanban cards) colour the
  selected task's bar, milestone diamond and a dot before its name; PDF export
  shows it as a coloured left border on the row.
- **Column widths**: drag the handle at the right edge of a header; the table
  is as wide as its columns and scrolls sideways inside its pane. Double-click
  a handle to forget that column's stored width.
- **Split width**: drag the divider between the table and the Gantt;
  double-click resets. Both widths render from local state while dragging and
  are written to the document once on pointer-up (one revision per drag), so
  read-only viewers can still resize for themselves without saving anything.
- **Zoom**: four time scales — months, weeks, days (default), hours — stepped
  with Ctrl + mouse wheel over the chart (a native non-passive listener, so the
  browser does not page-zoom), the −/+ control at the right of the toolbar, or
  the context menu. Zooming keeps the calendar instant under the cursor in
  place. The scale is stored in `layout.scale`; tasks stay day-granular, so the
  hours view is a finer grid, not finer data. Each scale pads the calendar
  differently (a months view of a two-week plan still shows a year).
- **Context menu**: right-click a Gantt bar, a row of the chart, or a table
  row for add-below / indent / outdent / move up / move down / colour / delete
  on that task; right-click empty space for add task / add milestone. Both
  menus end with the zoom scales and "Go to today". Inputs keep the browser's
  own menu. Read-only views get only the zoom and today items.
- **Reorder by drag**: the grip at the left of a task name drags the task and
  its descendants up or down the table; a line shows where the block lands,
  and it takes the parent of the row it is dropped in front of (dropped last =
  root level). Alt+↑ / Alt+↓ and the context menu remain the keyboard/menu
  paths. Dropping onto its own subtree is a no-op.

## On a page

| Fence | Body | Stored where |
| --- | --- | --- |
| ` ```project ` | JSON document | On the page (like an inline BeeDiagram) |
| ` ```project-ref ` | Plan id | Shared with the book-tree item |

Insert via **Add → Project** (inline) or **Add → Linked project** (creates the
book item and embeds it). Viewers get a read-only Gantt; editors can edit the
table and drag bars.

## MCP

`beedocs_create_project_plan_with_tasks` / `beedocs_update_project_plan_tasks`
accept structured tasks. Raw JSON goes through
`beedocs_create_project_plan` / `beedocs_update_project_plan`. Embed a stored
plan with:

````
```project-ref
PLAN_ID
```
````

See [MCP-TOOLS.md](./MCP-TOOLS.md).

## Search

Plans are indexed by the same trigger + queue pipeline as everything else
(`kind = 'project'`). Task titles and assignee names are searchable;
`project-ref` fences on a page do not re-index the plan (the plan's own row
does). Unknown `search_queue` kinds drain as deletes — keep `project` wired in
`SearchIndexService`.

# Diagram Studio (draw.io-style editor)

BeeDiagram documents (`kind: beediagram`) can be edited in two modes. The switch
sits above the canvas and is remembered per browser.

| Mode | What it is |
|------|------------|
| **Studio** (default) | A diagrams.net/draw.io-style workspace: shape palette, infinite canvas, format panel |
| **Classic** | The original compact BeeDocs editor — also used for inline ` ```beediagram ` fences in pages |

Both modes read and write the same JSON document, so you can move between them at
any time, and diagrams built in Studio render unchanged in page previews, the
thumbnail and the PDF/HTML export.

## Creating shapes

- **Drag** a shape from the left palette onto the canvas, or **click** it to drop
  it in the middle of the view (repeat clicks cascade so nothing stacks).
- **Search** the palette to filter across all groups (General, Flowchart,
  BeeDocs classic, **App collections**, and **Book collections** when a book is
  open).
- **Double-click empty canvas** to open the quick shape picker.
- **Drop or paste an image** anywhere on the canvas to upload and place it.

## Shape collections

A **collection** is a reusable multi-shape snippet (nodes + edges between them).
Select one or more shapes, then:

- Toolbar **Save collection**, or
- Right-click → **Save as collection…**

Give it a **name**, optional **description**, and choose the scope:

| Scope | Where it lives | Palette group |
|-------|----------------|---------------|
| **This book** | Only the current book | **Book collections** |
| **App library** | Whole BeeDocs instance | **App collections** |

App collections appear in every book's Studio palette. Book collections appear
only for diagrams in that book.

**Book** collections travel with the book in `.beedocs` archive export/import.
Deleting a book removes its book collections but leaves the app library alone.

## Connecting shapes

Hover a shape — draw.io's two affordances appear:

- **Blue arrows** on the four sides: **drag** one to another shape to connect, or
  **click** it to create a connected copy in that direction (its label opens for
  editing straight away).
- **Green ✕ marks** on the outline — up to 16 fixed connection points: the four
  side midpoints, the four corners, and the quarter points of every side (those
  appear once a side is long enough on screen to stay readable). Drag from one
  for a *fixed* connection. Dragging from the shape's edge or dropping on a shape
  body instead creates a *floating* connection that re-routes as shapes move.
  Connection points are hidden while a shape is selected, because the resize
  handles occupy the same spots — click empty canvas to deselect, or use the
  blue arrows, which also anchor to a fixed side.
- Dropping a connection on empty canvas offers a shape to connect to.

Select a connection to drag its **bend points** (round handles) or **endpoints**
(re-attach to another shape). Line style — orthogonal (default), straight or
curved — is in the toolbar, the Format panel, or the right-click menu.

## Editing

- **Select**: click, `Shift`/`Ctrl`-click to add, or rubber-band across the canvas.
- **Move**: drag; alignment guides snap edges and centres to nearby shapes
  (hold `Alt` to ignore the grid and guides).
- **Resize / rotate**: handles around a single selected shape (`Shift` keeps the
  ratio while resizing and snaps rotation to 15°).
- **Rename**: double-click a shape or connection, or `F2`. `Esc` applies.
- **Format panel**: Style (fill, line, width, opacity, dashed, shadow, shape
  swap), Text (label, size, colour, bold/italic, alignment), Arrange (size,
  position, angle, z-order, align, distribute). Multi-part shapes expose more
  than one fill colour — e.g. container header/body, cube front vs top/side,
  note paper/fold, cylinder body/top.

## Containers

The **Container** shape (Shapes → General) groups other shapes.

- **Put a shape in**: drag it over the container, or drop it straight from the
  shape palette. The container outlines in the accent colour while it is the
  drop target. A shape is taken in when it is fully inside, or when its centre
  is — so a shape hanging over the edge still lands in the container it mostly
  covers.
- **Take a shape out**: drag it off the container. Dropping it on empty canvas
  or on a different container moves it there.
- **Move the container** and everything inside travels with it. Delete or copy
  the container and its contents follow.
- **Containers nest** — drop one container into another. A container can never
  be dropped into itself or into its own contents.
- Dragging a multi-selection only re-parents it when *every* shape lands in the
  same container, so a selection straddling the border is never split up.

Children keep absolute coordinates: **resizing** a container does not move or
clip what is inside, and the contents are not confined to its bounds. The link
is recorded as `parentId` on the child (see below). A child always draws on top
of its container, and connections between shapes inside a container paint after
that container's fill so they stay visible.

Classic mode has no container interaction — it ignores `parentId`, so moving a
container there leaves its contents behind.

## Keyboard

| Keys | Action |
|------|--------|
| `Ctrl+Z` / `Ctrl+Shift+Z`, `Ctrl+Y` | Undo / redo |
| `Ctrl+C` / `Ctrl+X` / `Ctrl+V` / `Ctrl+D` | Copy / cut / paste / duplicate |
| `Ctrl+A`, `Del`, `Esc` | Select all, delete, deselect |
| `F2` / `Enter` | Edit label |
| Arrows / `Shift`+Arrows | Nudge 1px / one grid step |
| `Ctrl+Shift+F` / `Ctrl+Shift+B` | Bring to front / send to back |
| `Ctrl+Shift+H`, `Ctrl` `+`/`-`/`0` | Fit page, zoom in/out/100% |
| `Space`-drag, middle-drag, `Ctrl`+wheel | Pan, pan, zoom |

## Document format

Studio only adds optional fields to the existing BeeDiagram JSON, so older
documents keep working and stay editable in Classic mode:

```jsonc
{
  "nodes": [{
    "id": "n_1", "type": "box", "label": "API",
    "x": 120, "y": 80, "w": 140, "h": 70,
    "shape": "rounded",              // draw.io-style shape (optional)
    "icon": "aks",                   // shape="azure" only: stencil id (see below)
    "rotation": 15,                  // degrees (optional)
    "parentId": "n_0",               // id of the container shape holding this
                                     // node (optional); coordinates stay absolute
    "style": { "fill": "#dae8fc", "fill2": "#ffffff", // fill2 = 2nd part of
                                                     // multi-part shapes
               "stroke": "#6c8ebf", "dashed": true,
               "fontSize": 12, "bold": true, "align": "center" }
  }],
  "edges": [{
    "id": "e_1", "from": "n_1", "to": "n_2",
    "fromAnchor": "e", "toAnchor": "w",   // n/e/s/w, corners (ne/se/sw/nw),
                                          // or side quarter points (n1/n2/e1/e2/s1/s2/w1/w2)
    "route": "orthogonal",                // straight | curved | orthogonal
    "waypoints": [{ "x": 300, "y": 120 }],
    "style": { "stroke": "#141a21", "endArrow": "arrow", "dashed": false }
  }]
}
```

Nodes without `shape` render with their classic `type` appearance
(box / person / system / database / note / image).

## Azure stencils

The palette carries a separate Azure collection, grouped the way the
[Azure architecture icons](https://learn.microsoft.com/en-us/azure/architecture/icons/)
are — Compute, Containers, Storage, Databases, Networking, Integration,
Identity & security, Analytics & AI, Management — plus **Azure · Boundaries**
for the dashed subscription / resource-group / VNet / subnet / region frames.
The boundaries are ordinary `container` shapes, so nesting, grouped moves and
drop-to-adopt all work as usual.

A service shape is `"shape": "azure"` plus an `"icon"` id
(`aks`, `app-service`, `sql-database`, `table-storage`, …). The registry lives in
`src/beedocs-web/src/diagram/azureIcons.ts`; `id` is the stored value, so it must
stay stable when a service is renamed. Select a shape and use **Format → Style →
Service** to swap one stencil for another without redrawing.

Stencils are drawn with the same primitive model as every other shape (geometry
authored in a 100 × 100 box, placed with one `transform`), so they render
identically in Studio, in page previews and in the PDF/HTML export. They are
BeeDocs' own drawings in Azure's palette rather than Microsoft's artwork —
recognisable stand-ins that carry no redistribution question. Swapping in the
official SVGs later is a data-only change to that one file.

The icon keeps its brand colours; a node's `style.fill` / `style.stroke` draw an
optional backplate behind it (nothing is drawn while both are unset).

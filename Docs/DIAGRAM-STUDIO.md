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
  BeeDocs classic).
- **Double-click empty canvas** to open the quick shape picker.
- **Drop or paste an image** anywhere on the canvas to upload and place it.

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
  position, angle, z-order, align, distribute).

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
    "rotation": 15,                  // degrees (optional)
    "style": { "fill": "#dae8fc", "stroke": "#6c8ebf", "dashed": true,
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

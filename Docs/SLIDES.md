# Slides

PowerPoint-style presentations that live in a book next to pages and diagrams:
a **slide deck** is one document holding an ordered list of slides, each slide
an ordered list of absolutely-positioned elements. The workspace ships a
designer (filmstrip · editing canvas · format panel) and a full-screen
presentation mode.

## Where things live

| Piece | Location |
| --- | --- |
| Entity + DTOs | `src/BeeDocs.Api/Models/Entities.cs` (`SlideDeck`), `Models/Dtos.cs` |
| Service + endpoints | `Services/SlideDeckService.cs`, mapped in `Program.cs` |
| Document schema | `src/beedocs-web/src/slides/slideModel.ts` (the one source of truth) |
| Designer | `src/beedocs-web/src/slides/SlideEditor.tsx` |
| Presenter | `src/beedocs-web/src/slides/SlidePresenter.tsx` |
| Shared renderer | `src/beedocs-web/src/slides/SlideView.tsx` |
| Route canvas | `src/beedocs-web/src/components/SlideCanvas.tsx` (`/books/{bookId}/slides/{deckId}`) |

## REST endpoints

Same shape as diagrams — id-based, behind the standard `/api` auth filter:

```
GET    /api/books/{bookId}/slides     → SlideDeckSummary[] (includes slideCount)
POST   /api/books/{bookId}/slides     { title, source? }   → SlideDeck
GET    /api/slides/{id}               → SlideDeck
PUT    /api/slides/{id}               { title, source? }   → SlideDeck (null source = leave unchanged)
DELETE /api/slides/{id}
```

Deleting a book cascades into its slide decks, like pages and diagrams.

## Document format (`slide_deck.source`)

```jsonc
{
  "version": 1,
  "size": { "w": 1280, "h": 720 },            // slide coordinate space (16:9)
  "theme": { "background": "#ffffff", "color": "#1f2430",
             "accent": "#f59e0b", "fontFamily": "…" },
  "slides": [
    {
      "id": "slide-…",
      "background": "#…",                      // optional per-slide override
      "notes": "speaker notes",                // optional, never rendered on the slide
      "elements": [
        {
          "id": "el-…",
          "kind": "text" | "shape" | "image",
          "x": 0, "y": 0, "w": 100, "h": 100,  // slide coordinates
          "rotation": 0,
          // text (also the label inside a shape):
          "text": "…", "fontSize": 28, "bold": true, "italic": false,
          "underline": false, "align": "left|center|right",
          "valign": "top|middle|bottom", "color": "#…",
          // kind=shape:
          "shape": "rect|rounded|ellipse|triangle|diamond|star|arrow|line",
          "fill": "#… | none", "stroke": "#… | none", "strokeWidth": 2,
          "opacity": 100,
          // kind=image:
          "imageUrl": "/uploads/…"
        }
      ]
    }
  ]
}
```

Element **array order is z-order** — later elements draw on top, so restacking
is an array move. The API stores the document verbatim; the server only reads
`slides[].elements[].text` and `slides[].notes` (search indexing) and
`slides.length` (the tree's slide-count badge), so new fields can be added in
`slideModel.ts` without a server change. `parseDeck` is deliberately tolerant:
missing fields take defaults, a broken document opens as a one-slide blank deck.

## Designer

- **Filmstrip** (left): click to select, drag to reorder, `+ New slide`.
- **Toolbar**: insert text box / shape / image (uploaded via `/api/uploads`),
  add slide from a layout (title, title + content, two content, section,
  blank), duplicate/delete slide, theme presets, **Present**.
- **Canvas**: drag to move (snaps to a 5 px grid), 8 handles to resize,
  double-click to edit text in place, arrow keys nudge (Shift = 10),
  Delete removes, Ctrl+D duplicates the selected element.
- **Format panel** (right): with an element selected — font, alignment,
  colours, fill/outline, opacity, rotation, exact X/Y/W/H, z-order; with
  nothing selected — slide background, theme colours, speaker notes.

Saving reuses the shared auto-save (`useAutoSave`) and Ctrl+S, exactly like
pages and diagrams. Read-only accounts get a scrollable preview of every slide
plus Present — no editor.

## Presentation mode

The Present buttons (editor toolbar, workspace toolbar, properties pane) open a
full-screen overlay starting at the selected slide. It requests browser
fullscreen (best effort — the overlay works either way), and leaving fullscreen
ends the show so the two can't disagree.

Navigation: arrow keys / Space / Enter / PageUp·Down / Home / End, click to
advance, right-click to go back, **Esc** to end. A hover HUD bottom-right shows
`current / total` with prev/next/exit buttons.

## Templates

A deck can be saved as an app-wide **template** (`slide_template` table — just a
name plus the same JSON document, no book): toolbar → *Save as template*. The
*New slides* dialog then offers every template next to *Blank deck*; creating
from one copies the template's document into the new deck
(`POST /api/books/{id}/slides` with `templateId`), so later edits to either
never affect the other. Templates are deliberately not search-indexed —
they're scaffolding, not content.

```
GET    /api/slide-templates          → SlideTemplateSummary[] (includes slideCount)
POST   /api/slide-templates          { name, source }  → SlideTemplate
GET    /api/slide-templates/{id}     → SlideTemplate
PUT    /api/slide-templates/{id}     { name, source? } → SlideTemplate (null source = rename only)
DELETE /api/slide-templates/{id}
```

## Export (PowerPoint / Google Slides)

`GET /api/slides/{id}/export/pptx` renders the deck server-side as a real
OOXML PowerPoint file (`SlideDeckPptxExporter` — hand-built parts over
`System.IO.Compression`, no Office SDK). The 1280×720 canvas maps exactly onto
the 16:9 slide (9525 EMU/px), element order stays z-order, and text (font size,
bold/italic/underline, alignment, colour), all eight shapes, fills, outlines,
opacity, rotation and `/uploads` images carry over. External image URLs and
speaker notes are not exported.

The toolbar's *Export* menu offers **PowerPoint (.pptx)** and **Google
Slides** — the same file either way, since Google Slides imports .pptx
natively; the Google item additionally opens Google Slides where the file can
be imported via *File → Open → Upload*. A true "create in the user's Google
account" flow would need per-user Google OAuth, which a self-hosted instance
deliberately avoids.

## Search

Slide decks are indexed by the same trigger + queue pipeline as everything else
(`kind = 'slides'`): the indexable text is every element's `text` plus each
slide's `notes` — geometry and styling stay out. Hits carry the workspace URL
`/books/{bookId}/slides/{deckId}` and show up in Ctrl+K under "Slides".

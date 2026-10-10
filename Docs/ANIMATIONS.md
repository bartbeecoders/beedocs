# Animations — moving explanations

An animation is a short explainer video built from the document itself: scenes
in which boxes, arrows, text and icons appear, move and get emphasised in
step with a narration caption. It lives in a book next to pages, diagrams and
slide decks, stored as one JSON document. The same animation can be a **tree
item** (`/books/{bookId}/animations/{id}`) or **embedded on a page**, either as
an inline ` ```animation ` fence (the JSON lives on the page) or as
` ```animation-ref ` (the body is the animation id, and editing the embed
updates the stored item).

## Why fframes-style, and not fframes itself

[fframes](https://github.com/dmtrKovalenko/fframes) (MIT) is a Rust framework
for programmatic video. A video is a Rust program, `render_frame(frame)`
returns an SVG tree for that instant, and `timeline!` keyframes with easing
drive the motion. Every video is a compiled crate, so it can't serve as a
document format that people edit in a browser and AI agents write over an API.

BeeDocs takes fframes' model rather than its runtime:

- **A frame is a pure function of time.** `renderFrameSvg(doc, t)` in
  `src/beedocs-web/src/animation/animModel.ts` returns the SVG for instant
  `t`. It keeps no playback state, so any instant can be rendered on its own.
  Scrubbing, the poster frames in the PDF export and the frames of a video
  export all call the same function.
- **One renderer everywhere.** The editor stage, the player, page embeds,
  PDF export and video export all draw through `renderFrameSvg`. An animation
  therefore looks the same wherever it appears.
- **Keyframes plus easing.** `keyframes` and the `enter`, `emphasis` and
  `exit` cues use the curve names fframes and CSS use.
- **A bridge to the real thing.** *Export as fframes project* generates a
  Rust crate (`Cargo.toml` + `src/main.rs`). The generated `render_frame`
  rebuilds the same frames with `svgr!`, so anyone with a Rust toolchain can
  render a GPU-quality MP4 with `cargo run --release -- render`. This has been
  verified: the generated crate builds against fframes `1.2.1-rc.14` from
  crates.io, and fframes' `strip` / `inspect` tools render the frames
  correctly with the CPU renderer. Known gap: colour emoji (`icon` elements)
  don't render in fframes/resvg. They show only in the browser.

## Where things live

| Piece | Location |
| --- | --- |
| Entity + DTOs | `src/BeeDocs.Api/Models/Entities.cs` (`Animation`), `Models/Dtos.cs` |
| Service + endpoints | `Services/AnimationService.cs`, mapped in `Program.cs` |
| AI explainer | `Services/AnimationExplainerService.cs`, the `explainer` task in `LlmPrompts` (`Services/LlmClient.cs`) |
| Document schema + renderer | `src/beedocs-web/src/animation/animModel.ts` (the one source of truth) |
| Editor / player / embed view | `src/beedocs-web/src/animation/` |
| MCP tools | `src/BeeDocs.Mcp/Tools/AnimationTools.cs` |

## REST endpoints

They take the same shape as kanban boards: id-based, behind the standard
`/api` auth filter.

```
GET    /api/books/{bookId}/animations             → AnimationSummary[] (includes sceneCount)
POST   /api/books/{bookId}/animations             { title, source?, ownerId?, isPrivate? } → Animation (201)
POST   /api/books/{bookId}/animations/from-page   { pageId, title?, sceneCount?, instructions? } → Animation (201)
GET    /api/animations/{id}                       → Animation
PUT    /api/animations/{id}                       { title, source?, ownerId?, isPrivate? } → Animation (null source = leave unchanged)
DELETE /api/animations/{id}
```

`Animation` is `{ id, bookId, title, source, ownerId, ownerName, isPrivate,
createdAt, updatedAt }`. The summary swaps `source` for `sceneCount`.

The `animation` table has the same storage shape as `kanban_board`. Every
place that knows about content kinds knows about it, under the kind name
`animation`:

- bodies follow the `content_ref` offload (`ContentRef.AnimationKey`);
- deleting a book cascades into its animations;
- backups capture offloaded bodies;
- privacy, favorites and stats include it;
- search triggers queue `kind = 'animation'`.

## Turn a page into an explainer (AI)

`POST /api/books/{bookId}/animations/from-page` hands one page to the
**default LLM provider** using the `explainer` task:

- **Input.** The page title plus its Markdown, capped at 12k characters.
  Fenced blocks become `[embedded lang]` via `ReorgText.Excerpt`, so diagram
  JSON never reaches the model.
- **Prompt.** The system prompt teaches the full schema below plus layout
  rules:
  - one idea per scene, title scene first and recap last;
  - stagger enter cues so the picture builds while the narration speaks;
  - short on-screen labels, with the fuller explanation in the narration;
  - boxes plus `draw` arrows for flows, and `type` for key sentences;
  - an emoji icon per idea;
  - a 60 px margin, with the bottom 110 px kept free for captions.
- **Call settings.** JSON response mode on providers that support it,
  reasoning `low`, a 180 s budget and a 12k-token answer.
- **Validation.** The reply is model output, so it's checked rather than
  trusted:
  - fences and chatter around the outermost `{…}` are stripped;
  - an answer without a non-empty `scenes` array is refused;
  - missing or duplicate ids are filled in or made unique;
  - `version`, `width`, `height`, `fps`, `background`, `accent`,
    `captions` and scene `duration` get defaults.

  Subtler problems, such as an unknown preset or an element off the stage,
  are left to the web parser, which is tolerant by design.
- **Result.** A new animation in the book, titled `"<page title> —
  explained"` unless `title` is given. The call is synchronous and takes up
  to about three minutes, so clients use a long timeout.
- **Errors.** No provider configured, the provider failing, or an unusable
  answer all return **502** `{ "error": "…" }`, like the other LLM routes.
  An unknown book or page (including a page the caller can't see) returns
  **404**, and an empty page returns **400**.

## Document format (`animation.source`)

```jsonc
{
  "version": 1,
  "width": 1280, "height": 720,     // stage pixels
  "fps": 30,                        // video export frame rate
  "background": "#0f172a",
  "accent": "#f59e0b",
  "captions": true,                 // draw each scene's narration as a caption bar
  "scenes": [                       // played back to back
    {
      "id": "s1",
      "title": "How a request flows",
      "duration": 6,                // seconds
      "narration": "The browser asks the gateway, which routes to the service.",
      "transition": "fade",         // none | fade | slide | zoom — how it arrives from the previous scene
      "transitionDuration": 0.6,
      "background": "#0f172a",      // optional override
      "elements": [                 // array order = z-order
        {
          "id": "e1",
          "type": "box",            // text | box | circle | line | arrow | icon | image | path
          "x": 140, "y": 300, "w": 260, "h": 130,   // element box, top-left origin
          "text": "Gateway", "fontSize": 34, "bold": true, "color": "#0f172a",
          "fill": "#f59e0b", "radius": 18,
          "enter":    { "preset": "pop",   "at": 0.3, "duration": 0.6, "easing": "easeOutBack" },
          "emphasis": { "preset": "pulse", "at": 3.6, "duration": 0.7 },
          "exit":     { "preset": "fade",  "at": 5.4, "duration": 0.4 },
          "keyframes": [ { "t": 2.0, "x": 500, "easing": "easeInOut" } ]
        }
      ]
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `x, y, w, h` | Element box on the stage (lines and arrows: `x,y` is the start, `x2,y2` the end) |
| `text` | Body (`text`, may contain `\n`), label (`box`/`circle`/`arrow`), or one emoji (`icon`) |
| `fontSize`, `font`, `bold`, `align`, `color` | Typography: `font` is `sans` / `serif` / `mono`, `align` is `start` / `middle` / `end` |
| `fill`, `stroke`, `strokeWidth`, `radius`, `opacity`, `dashed` | Shape style |
| `src` | Image URL (`image`) |
| `d` | SVG path data (`path`), **relative to the element box**: 0,0 is its top-left, and `x/y/w/h` position it |
| `enter.preset` | `none` `fade` `rise` `drop` `slide-left` `slide-right` `pop` `zoom` `draw` (trace the outline or line) `type` (typewriter) `wipe` |
| `emphasis.preset` | `pulse` `shake` `glow` `spin` |
| `exit.preset` | `none` `fade` `sink` `shrink` `slide-left` `slide-right` |
| `easing` | `linear` `easeIn` `easeOut` `easeInOut` `easeOutBack` `easeOutElastic` `easeOutBounce` |
| `keyframes` | `{t, x?, y?, opacity?, scale?, rotate?, easing?}`. A keyframe's pose holds until the next one, which is approached with that keyframe's easing. Omitted properties carry over. |

All cue `at` and keyframe `t` values are **seconds from the start of their
scene**. Before its `enter` cue an element is hidden, and after its `exit`
cue it's gone.

The API stores the document verbatim. The server reads only scene titles,
narration and element `text` (search) and the scene count (the tree badge),
so new fields can be added in `animModel.ts` without a server change.
`parseAnimation` is deliberately tolerant: unknown fields and presets drop
out, and a broken document opens as one empty scene.

## Playing and exporting

- **Player.** Play/pause, a scrubber with scene markers, captions and
  fullscreen. Read-only accounts get the player, because watching is not a
  write affordance.
- **Video export (MP4 or WebM).** Runs in the browser (`animExport.ts`).
  Each frame's SVG is drawn to a canvas that `MediaRecorder` records — MP4
  (H.264) where the browser can, WebM otherwise. MediaRecorder timestamps by
  wall clock, so frames are pushed at the document's real `fps` and an export
  takes as long as the animation plays. Images are inlined as data URLs first,
  because an SVG drawn as an image can't fetch external resources.
- **Save this frame.** The frame at the playhead as a full-size PNG.
- **fframes project export.** Covered in the fframes section above.
- **PDF / print.** One poster frame per scene, taken at the moment
  everything has entered and before any exit, followed by the scene title
  and narration. That's how a moving explanation reads on paper.

## On a page

| Fence | Body | Stored where |
| --- | --- | --- |
| ` ```animation ` | JSON document | On the page |
| ` ```animation-ref ` | Animation id | Shared with the book-tree item |

## MCP

`AnimationTools.cs` has these tools:

- `beedocs_list_animations`
- `beedocs_get_animation`
- `beedocs_create_animation`, which creates from a JSON document you author
  (video as code)
- `beedocs_update_animation`
- `beedocs_delete_animation`
- `beedocs_create_animation_from_page`, which runs the AI explainer above

The create tools return the workspace URL and an embed fence:

````
```animation-ref
ANIMATION_ID
```
````

See [MCP-TOOLS.md](./MCP-TOOLS.md).

## Search

Animations go through the same trigger + queue pipeline as everything else
(`kind = 'animation'`). Scene titles, narration and element text are
searchable. Inline ` ```animation ` fences on a page contribute the same text
to that page. ` ```animation-ref ` fences contribute nothing, because the
stored animation has its own row.

# Word documents

A `.docx` filed against a book opens in a Word-like editor instead of as a
download. Drop a Word file on a book (tree node or overview), or pick
**New Word document** in the book's context menu for a blank one; either way
the file is an ordinary [attachment](ATTACHMENTS.md) — same row, same
`/books/{bookId}/files/{id}` route, same download — that the workspace knows
how to open.

## What it looks like

- **Ribbon** — File · Home · Insert · Layout · View, plus contextual Picture
  and Table tabs. Home carries clipboard, font (family, size, grow/shrink,
  bold/italic/underline/strike/sub/sup, highlight, colour, clear formatting),
  paragraph (bullets, numbering, indent, alignment, line and paragraph
  spacing), the styles gallery (Normal, No Spacing, Heading 1–3, Title,
  Subtitle, Quote) and Find. Insert: table (size picker), picture, link, page
  break, horizontal line, date, symbols. Layout: margins, orientation, paper
  size. View: print/web layout, ruler, zoom.
- **Print layout** draws real pages with the document's own paper size and
  margins; **web layout** is one continuous sheet. A ruler shows margins in
  cm (or inches for US paper). The status bar has page x of y, word count,
  save state and a zoom slider.
- **Shortcuts** — Ctrl+S save, Ctrl+Z/Y undo/redo, Ctrl+B/I/U, Ctrl+E/J/R
  align, Ctrl+]/[ font size, Ctrl+Enter page break, Ctrl+K link,
  Ctrl+Alt+1/2/3 headings, Ctrl+Shift+N Normal, Ctrl+F find, Tab in a table
  moves to the next cell (Shift+Tab back), Tab in a list nests.
- **Saving** is automatic 1.5 s after the last change (the same auto-save the
  page editor uses), and Ctrl+S / File → Save force it. Read-only accounts get
  the document rendered with File (download, print) and View only.
- Dropping or pasting an image embeds it; dropping any other file on the
  canvas replaces the attachment, as it does for every file.

## How it works

Nothing in BeeDocs models a Word document. The editor is the browser's own
`contentEditable` over HTML, and the two directions of the conversion live in
`src/BeeDocs.Api/Services/Word/`:

- `DocxReader` — package → HTML + CSS + page setup (`GET /api/attachments/{id}/word`).
  `word/document.xml` is walked once; paragraphs keep their **style id**
  (`data-style="Heading1"`, headings additionally as `<h1>`–`<h6>`), runs
  become spans with inline CSS, lists are rebuilt from `numbering.xml`
  (`<ul>`/`<ol>` nested by level, `data-num` = the original numId), tables
  carry spans, widths and shading, pictures point at
  `GET /api/attachments/{id}/word/media/{part}`. `styles.xml` is resolved
  through its `basedOn` chains into a stylesheet scoped to `.docx-body`, so a
  heading looks like *this document's* heading; gallery styles the file lacks
  render (and, once used, save) as Word's defaults (`WordStyleDefaults`).
- `DocxDocumentWriter` — HTML → package (`PUT /api/attachments/{id}/word`).
  Only `word/document.xml` is regenerated; every other part is copied
  through, and the parts that must grow are appended to: relationships for
  new pictures and links, `w:num` instances for new lists (new abstract
  definitions only when the file has none of the right kind), style
  definitions the document lacked. That is what keeps a save
  non-destructive: headers, footers, theme, footnotes, comments and settings
  survive untouched. The body-level `sectPr` is copied verbatim unless the
  request carries a `page`, which rewrites `pgSz`/`pgMar` only.
- `HtmlLite` — a forgiving HTML parser (implicit `<p>`/`<li>`/`<td>` closing,
  entities via `WebUtility`), so an agent's hand-written HTML is accepted as
  readily as the browser's `innerHTML`.

What has no HTML shape is carried through as an **opaque chunk**: complex
fields (TOC, PAGE, REF…), footnote/endnote/comment references, content
controls, shapes and text boxes, embedded objects are emitted as
`<span class="docx-raw" contenteditable="false" data-docx-raw="{base64 XML}">`
showing their cached text, and written back verbatim. Delete the chunk and it
is gone; leave it and Word finds it where it was. Pictures also carry their
original run as `data-docx-raw` and are re-emitted from it unless resized
(`data-resized`), so effects and cropping survive an untouched picture.
Tracked changes are accepted on save (`w:ins` kept, `w:del` dropped).

### HTML dialect

`<p>`, `<h1>`–`<h6>`, `<ul>`/`<ol>`/`<li>`, `<table>`/`<tr>`/`<td>`
(`colspan`, `rowspan`, `data-borders="0"` for borderless), `<b>/<i>/<u>/<s>/<sub>/<sup>`,
`<span style>` (font-weight, font-style, text-decoration, color,
background-color → highlight when it is one of Word's fifteen colours else
shading, font-size in pt, font-family, vertical-align, letter-spacing,
text-transform), `<a href>`, `<img src="data:…" width height>` or an existing
part via `data-media`, `<hr>` (bottom-border paragraph), `<hr data-break="page">`,
block styles `text-align`, `margin-left/right/top/bottom`, `text-indent`,
`line-height` (unitless → auto, pt → exact). Whitespace is significant
(`pre-wrap`): tabs are tabs, a newline in text is a line break. Blank lines
are `<p><br></p>`; a trailing `<br>` in a block is the browser's placeholder
and is ignored.

### Editor internals (`src/beedocs-web/src/word/`)

- `WordEditor.tsx` owns the body, load/save, selection tracking and keyboard;
  `Ribbon.tsx` is the chrome; `commands.ts` the formatting verbs (inline via
  `execCommand`, paragraph-level by hand on the blocks the selection touches,
  because `formatBlock` cannot carry a style id).
- `paginate.ts` — print layout without splitting the DOM: one write pass
  clears old pushes, one read pass measures every block, one write pass gives
  the blocks that would straddle a page boundary an extra top margin
  (`data-bee-push`, stripped on save). Page backgrounds are drawn underneath
  at fixed intervals. The body is a flex column so margins never collapse and
  Word's additive spacing holds. A page-break rule sends what follows to the
  next page; a block taller than a page overlaps the gap rather than being
  torn.
- `undo.ts` — the editor's own history (snapshots + selection paths), since
  the ribbon's DOM edits are invisible to the browser's native stack.
  Keystrokes coalesce; a space, Enter, paste or format starts a new step, so
  Ctrl+Z steps back a word at a time.
- `serialize.ts` — what leaves the editor (pushes, selection marks and
  blob sources stripped) and paste sanitising (Word's clipboard HTML reduced
  to the dialect above).

## MCP

`beedocs_read_word_document` / `beedocs_write_word_document` /
`beedocs_create_word_document` (`BeeDocs.Mcp/Tools/WordTools.cs`) expose the
same routes: an agent reads the body as HTML, edits, and writes the whole body
back — the file stays a real `.docx`. `beedocs_read_attachment` still returns
a `.docx` as base64; the tool descriptions steer agents to these instead.

## Limits

- `.docx` only — `.doc`, `.odt` and `.rtf` keep the download placeholder.
- Headers and footers, footnote text, comments are preserved but not shown
  (the status bar says so). Anchored pictures render inline. Section breaks
  mid-document are kept (`data-sect`) but every page is drawn with the last
  section's size.
- A table never splits across pages in the editor's print layout; Word
  reflows it when the file is opened there.

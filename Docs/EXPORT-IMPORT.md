# Export & import

Move books and documents out of BeeDocs — and back in.

| | Book | Single document |
|---|---|---|
| **PDF** | ✅ | ✅ |
| **Markdown** | ✅ zip, structure preserved | ✅ single `.md` |
| **Word (`.docx`)** | ✅ | ✅ |
| **BeeDocs archive (`.beedocs`)** | ✅ | ✅ |
| **Re-importable** | archive, Markdown | archive, Markdown |

---

## Exporting

**From the UI:** the **Export ▾** button on a book's overview page, the **⭳**
button in the page toolbar, or right-click any book or page in the library tree
→ **Export as**.

**From the API:**

```bash
curl -OJ "http://localhost:5080/api/books/<bookId>/export?format=archive"
curl -OJ "http://localhost:5080/api/pages/<pageId>/export?format=docx"
```

`format` accepts `archive`, `markdown`, or `docx` (aliases: `beedocs`, `md`,
`word`). PDF is not an API format — see below.

### PDF

PDF is generated **in the browser**, not by the API. Mermaid and BeeDiagram
content only exists as a rendered DOM, so the exporter builds a print-styled
page and opens the browser's print dialog — choose *Save as PDF*. Allow pop-ups
for the site or the print window is blocked.

This is the only format that renders diagrams as pictures.

### Markdown

A book exports as a zip mirroring its structure:

```
README.md                     index with a linked table of contents
<folder-slug>/<page-slug>.md  pages inside folders
<page-slug>.md                pages at the book root
diagrams/<title>.json|.mmd    diagram sources
assets/<file>                 images referenced by pages
```

Each page carries YAML front matter, which is what makes a Markdown export
re-importable:

```markdown
---
title: "Deploying"
slug: "deploying"
folder: "Runbooks"
sortOrder: 1
updatedAt: 2026-07-29 12:49:26Z
exportedBy: BeeDocs
---

# Deploying
…
```

A single document exports as one `.md` file with the same front matter.

### Word (`.docx`)

A real WordprocessingML document with headings (navigable in Word's outline
pane), paragraphs, bold/italic/strikethrough, inline code, hyperlinks, bulleted
and numbered lists, block quotes, tables, horizontal rules, and embedded images.
A book gets a title page and a contents list; each page starts on a new page.

Known limits:

- **Diagrams are not rendered.** Mermaid, C4, PlantUML and BeeDiagram fences
  appear as captioned source blocks — rasterising them needs a browser, which
  the API does not have. Use PDF when you need diagram images.
- **SVG images are not embedded** (the format cannot hold them); they appear as
  `[image: alt (url)]`. PNG, JPEG, GIF and WebP embed normally.
- Nested lists are flattened to a single level.

The writer is hand-rolled (`Services/DocxWriter.cs`) rather than using the
OpenXML SDK, so the API takes no extra dependency.

### BeeDocs archive (`.beedocs`)

The lossless format, and the one to use for moving content between instances or
for backups. It is a zip:

```
beedocs.json     manifest: book, folders, pages, diagrams, shape collections, asset list
assets/<file>    every image the content references
README.txt       what the file is and how to import it
```

Records are linked by local refs (`p1`, `ch2`, …) rather than database ids, so
an archive never collides with existing records on import. Original ids are kept
alongside so `beediagram-ref` fences can be re-pointed at the diagrams created
on import.

---

## Importing

**From the UI:** **Import** in the library toolbar, or right-click a book →
**Import into this book…** to preselect it as the destination.

The file is inspected first — you see what is inside and can resolve a name
clash — before anything is written.

**From the API:**

```bash
curl -F file=@handbook.beedocs -F mode=rename http://localhost:5080/api/import

# see what is in a file without importing it
curl -F file=@handbook.beedocs http://localhost:5080/api/import/inspect
```

### Accepted files

| File | Result |
|---|---|
| `.beedocs` | Full fidelity: folders, pages, diagrams, images |
| `.zip` of Markdown | Pages and folders; front matter restores titles and order |
| `.md` / `.markdown` | A single page |

A zip is treated as an archive if it contains `beedocs.json`, otherwise as
Markdown. `README.md` in a Markdown zip is skipped — it is the generated index,
not a page.

### Options

**`mode`** — what to do when a title already exists:

| Mode | Book | Pages | Folders |
|---|---|---|---|
| `rename` (default) | `Handbook` → `Handbook (2)` | `Deploying` → `Deploying (2)` | new folder alongside |
| `keep` | keeps `Handbook`, creating a second one | keeps the name; existing pages untouched | reuses the existing folder of that name |

**`targetBookId`** — import into an existing book instead of creating one. Its
pages and diagrams are added to that book; nothing existing is modified or
deleted. Import never overwrites.

**`title`** — override the new book's title outright.

### What happens to images and diagrams

- Every image in the file is written into the uploads store under a **fresh
  name**, and the URLs in page content and diagram sources are rewritten to
  match. Imported content never points at another instance's files.
- Diagrams and **book** shape collections are recreated in the destination book
  (app-wide collections stay on the instance and are not in the archive) and
  `beediagram-ref` fences are
  rewritten to the new ids, so embedded diagrams keep working.
- Importing a Markdown file that references stored diagrams produces a warning:
  Markdown does not carry them, so those blocks show as missing. Use an archive
  to move diagrams.

### Slugs

Slugs are regenerated from the title on import rather than copied, so they stay
unique within the destination. Titles, folder assignment and sort order are
preserved.

---

## Round-trip guarantee

`archive → import` restores folders, pages, page order, diagrams, diagram
attachments, embedded diagram references, and images.

`markdown → import` restores folders, pages, titles and order, but **not**
stored diagrams (their sources land in `diagrams/` for reference).

`docx` and `pdf` are presentation formats — they are not importable.

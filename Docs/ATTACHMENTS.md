# Attachments — files filed against a book

A book holds pages, diagrams and slide decks, all of which BeeDocs *authors*.
An **attachment** is the other case: a document that already exists and belongs
next to them — a signed PDF, a vendor's Word contract, a budget spreadsheet, a
Visio drawing, a zip of firmware. BeeDocs stores it, names it, records who is
answerable for it and hands it back on request; it does not try to edit it.

## The shape of it

| | Pages / diagrams / slide decks | Attachments |
|---|---|---|
| Payload | text in SQLite | opaque bytes on disk |
| Editable in the app | yes | no — download, or upload a replacement |
| Storage-provider offload | yes (`content_ref`) | no |
| Search index | full body text | metadata + extracted document text |

That first row is why the code looks different from `DiagramService` and
`SlideDeckService`: there is no `ContentResolver` in `AttachmentService` and no
`content_ref` column on `attachment`. A storage provider offloads *bodies of
text*, and an opaque binary is not one. The row is metadata; the bytes are a
file.

## Where the bytes live

`BeeDocs:AttachmentsPath` (default `data/attachments` under the API content
root). Each file is stored as `{attachmentId}{ext}` — never a name the uploader
chose, so a crafted file name cannot walk out of the directory. The original
name is kept in `attachment.file_name` and is what a download is served as.

This is deliberately **not** a corner of `BeeDocs:UploadsPath`. `/uploads` is
served by static-file middleware, and that middleware opens GET to anonymous
readers while any shelf is published — a published bookshelf embeds `/uploads`
URLs in its Markdown and would otherwise be full of broken images. Attachments
are reached only through `GET /api/attachments/{id}/download`, so they stay
behind the ordinary `/api` sign-in gate whatever any shelf is doing.

Both directories are content, so a container deployment wants a persistent
volume for each (or one volume with both paths inside it).

## What may be uploaded

An allow-list by **extension**, in `AttachmentService.AllowedTypes`: PDF, the
Microsoft Office and OpenDocument families, Visio, plain text / Markdown / RTF /
CSV, JSON / XML / YAML, ZIP / 7z / tar / gz, and raster images plus SVG so a
scan can be filed as a document.

The extension gates the upload, not the browser's `Content-Type`: content types
are trivially spoofed and browsers routinely send `application/octet-stream` for
a .docx anyway. The stored content type is then derived *from* the extension,
which is the thing that was actually checked.

Nothing executable or scriptable is on the list. The cap is 100 MB per file
(`MaxAttachmentBytes`), enforced against the declared length before the write
and against the bytes that actually landed afterwards — a chunked body declares
no length.

`src/beedocs-web/src/media/attachments.ts` duplicates the extension list and the
size cap. That is the one duplication worth having: it lets the file picker
filter, and lets a 300 MB file be refused before it is uploaded rather than
after. The server list stays the one that decides.

## API

| Route | Does |
|---|---|
| `GET /api/books/{bookId}/attachments` | list (title order) |
| `POST /api/books/{bookId}/attachments` | upload — multipart `file`, optional `title`, `description` |
| `GET /api/attachments/{id}` | metadata |
| `PUT /api/attachments/{id}` | properties: title, description, owner, download name |
| `POST /api/attachments/{id}/file` | replace the bytes, keep the id |
| `GET /api/attachments/{id}/download` | the bytes; `?inline=true` renders in place |
| `DELETE /api/attachments/{id}` | remove row and file |

`PUT` follows the `UpdateBookRequest` convention for its optional fields: **null
leaves it alone, `""` clears it**. The UI sends partial updates.

Replacing the file keeps the id, so a page linking to an attachment still links
to the new version — which is the point of having a replace route rather than
telling people to delete and re-upload. A replacement that changes the extension
writes the new path first and removes the old file only once the row points at
the new one: a crash in between leaves a stray file, never a row whose download
404s. `?inline=true` is honoured only for PDFs, plain text and raster images —
an inline SVG runs as script on this origin, which is exactly the session the
file is being served behind.

## Ownership, roles and lifecycle

`attachment.owner_id` names the account answerable for the file. It defaults to
the owning book's owner, falling back to whoever uploaded it, and — like every
other owner in BeeDocs — grants nothing: permissions stay role-based, so the
default read-for-everyone / write-for-editors rule applies unchanged.

Deleting a book cascades: `DocumentService.DeleteBookAsync` collects the stored
file names before the transaction, deletes the rows inside it, and removes the
files best-effort after the commit — the same order it already uses for cloud
content refs.

## Search

Attachments are indexed as kind `attachment` from their metadata **and the text
inside the document**, so a contract is findable by a clause in it rather than
only by what someone called the file.

`AttachmentTextExtractor` does the reading, on the search-index drain — in the
same no-transaction phase as a storage-provider fetch, because it touches a file
and must never sit inside the write lock.

| Format | Extracted | How |
|---|---|---|
| `.txt` `.md` `.csv` `.json` `.yaml` `.yml` `.log` | full text | read as UTF-8 |
| `.xml` `.svg` | text nodes | `XmlReader`, markup discarded |
| `.docx` | body, headers/footers, foot/endnotes | zip + `<w:t>` runs |
| `.pptx` | slide text and speaker notes | zip + `<a:t>` runs, slides in numeric order |
| `.xlsx` | cell text | zip + `xl/sharedStrings.xml` |
| `.odt` `.ods` `.odp` | body | zip + `content.xml` |
| `.rtf` | body | control words and metadata groups stripped |
| `.pdf` | page text | PdfPig |
| `.zip` | entry names | how you find "the zip with the firmware in it" |
| `.doc` `.xls` `.ppt` `.vsd(x)` `.7z` `.tar` `.gz`, images | — | metadata only |

Everything except PDF uses the BCL (`System.IO.Compression` + `System.Xml`).
**PdfPig** (Apache-2.0, pure managed, no transitive dependencies on net9.0+) is
the one added package, because PDF cannot be read without a parser and PDF is
the format people actually upload.

Three rules hold the feature together:

- **Extraction never throws.** A corrupt .docx, an encrypted PDF, a file that
  lies about its extension — all reduce to "no text". Metadata is indexed
  separately and always, so such a document is still findable by name.
- **Size is bounded twice.** Files over 32 MB (`MaxExtractBytes`) are indexed by
  metadata alone — the drain runs *before a search*, and a minute spent parsing a
  scanned manual there would make the whole library feel broken. Extracted text
  is then truncated at 256 KB (`MaxExtractedChars`) so one 500-page manual cannot
  dominate the index.
- **Improvements reach documents already uploaded.** `AttachmentTextVersion` is
  compared at startup against `app_setting['search.attachmentTextVersion']`; when
  they differ, every attachment is requeued. Reconcile cannot notice this on its
  own — it compares `updated_at`, and a document whose text we can now read
  better has not itself changed. Bump the constant whenever the extractor learns
  something new. The marker is written *before* the drain, so a document that
  crashes the extractor cannot cause a requeue loop on every restart.

A PDF that is a scan has no text layer and yields nothing; OCR is a different
feature with far heavier dependencies.

Published bookshelf websites still search only `page`, `book` and `folder`, so
document text does not reach a public reader site.

## UI

- Library tree: a **Files** group under each book, one row per attachment with a
  per-format glyph. Right-click for Open / Download / Delete.
- Upload: "Upload file" in the book toolbar, the book context menu, and the book
  overview — or **drag files in from the desktop**. Multi-select uploads several
  at once; a single file opens after upload, a batch leaves the view alone.
- Route `/books/{bookId}/files/{attachmentId}` — `AttachmentCanvas` renders a
  PDF or image in place and otherwise shows a download card naming the format.
- Properties pane: title, description, owner, download name, type, size,
  timestamps, plus Download / Save / Replace / Delete and a copyable Markdown
  link to the workspace route.

Saving properties is an explicit button rather than the auto-save the text
editors use: there is no stream of keystrokes to coalesce.

### Drag and drop

Three drop targets, all built on `useFileDropZone`:

| Drop on | Result |
|---|---|
| Anywhere under a book in the library tree | files that book |
| The book overview | files that book |
| An attachment's canvas | **replaces** that file, keeping its id and title |

Two things make this coexist with the tree's existing drags. First, every drop
target asks `dragHasFiles` before doing anything: the tree's own drags (pages,
folders, books) carry JSON on `text/plain`, so without that check a dropped PDF
would be parsed as a page move. Second, a book's drop zone wraps the whole book
node rather than sitting on individual rows, and the rows inside *decline* file
drags — returning before `stopPropagation` so the event reaches the zone. That
is why a document can be dropped on the book row, a folder, a page, or the gap
between them and still land in the same place. A shelf swallows file drops
without acting: it holds no content, so there is no book to file them against.

`useFileDropZone` counts dragenter/dragleave pairs rather than tracking a
boolean, because `dragleave` fires whenever the pointer crosses into a child
element — a boolean makes the highlight flicker its way across any zone that
contains anything. It also clears on a window-level `drop`/`dragend`, so a drag
abandoned outside the window cannot leave a zone lit.

`WorkspaceShell` additionally cancels file `dragover`/`drop` at the window, so a
drop that misses every zone is swallowed rather than becoming a *navigation* —
the browser's default is to leave the workspace and open the file, taking any
unsaved editor state with it.

## MCP

Eight tools in `BeeDocs.Mcp/Tools/AttachmentTools.cs`:
`beedocs_list_attachments`, `beedocs_get_attachment`, `beedocs_upload_attachment`,
`beedocs_read_attachment`, `beedocs_update_attachment`,
`beedocs_replace_attachment_file`, `beedocs_link_attachment_in_page`,
`beedocs_delete_attachment`. Files move as base64 over multipart.

Two decisions worth knowing:

`beedocs_read_attachment` returns **text** for text formats (TXT, MD, CSV, JSON,
XML, YAML, SVG) and base64 otherwise — an agent asking for a CSV wants its rows,
not base64 to decode. And it **refuses files over 8 MB**, returning the download
URL instead: the API accepts 100 MB, whose base64 is ~133 MB of text aimed
straight at a context window. The size is checked from metadata, before the bytes
cross the wire.

`beedocs_link_attachment_in_page` exists because filing a document and never
referencing it is half a job. It appends `[Title](/books/{bookId}/files/{id})` —
the workspace route, so a reader lands on the file with its properties rather
than triggering a blind download.

Attachment metadata also rides along in `beedocs_get_book_tree`,
`beedocs_export_book` and the `beedocs://books/{bookId}/attachments` resource, so
an agent surveying a book sees its files without a second call.

## Not in this version

- No storage-provider offload; attachments are always local, like uploads.
- No OCR: a scanned PDF has no text layer, so it indexes by metadata only.
- Legacy binary Office formats (`.doc`, `.xls`, `.ppt`) and Visio are not read.
- Not included in book export/import archives.
- No text extraction from document bodies for search.

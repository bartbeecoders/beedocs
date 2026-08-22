# REST API — publish documentation from other apps

BeeDocs exposes a **slug-based REST API** so external applications can publish
and update documentation without using the web UI or MCP.

**Base URL (local):** `http://localhost:5080`  
**Publish API prefix:** `/api/v1`  
**Content-Type:** `application/json`

The UI uses id-based routes under `/api/*`. Prefer **`/api/v1`** for integrations.

---

## Use case

An app wants to publish its configuration docs:

| Concept | Example |
|---------|---------|
| **Book** | Application1 |
| **Page** | Configuration |
| **Content** | Markdown describing settings, defaults, etc. |

Re-running the same publish call **updates** the page (idempotent by slug).

---

## Authentication

Optional shared secret. An admin sets or rotates it at runtime on the workspace's
**Settings → API access** page — it takes effect immediately, is stored write-only
(only the last four characters remain visible), and never requires a restart.
Configuration remains as a fallback for deployments that manage the key outside
the app:

| Source | Where | Precedence |
|--------|-------|------------|
| Settings page | Stored in the database, editable at runtime (admin only) | Wins when set |
| `BeeDocs:ApiKey` / env `BeeDocs__ApiKey` | Server configuration | Fallback when nothing is stored |

Send either:

```http
Authorization: Bearer <api-key>
```

or

```http
X-Api-Key: <api-key>
```

- **No key anywhere** — `/api/v1` is open (local dev). The API logs a warning at startup.
- **Key configured** — missing or wrong key → `401 Unauthorized`.

The same key is how non-browser clients (the MCP server, publishing apps)
authenticate against `/api/*` when sign-in (`BeeDocs:Auth:Enabled`) is on — with
sign-in on and **no** key configured, those clients cannot authenticate at all
and every call they make is a 401.

`/api/health` stays open and does not require a key.

---

## Quick start — one-shot publish

Create or update a book and a Markdown page in a single call:

```bash
curl -sS -X PUT "http://localhost:5080/api/v1/publish" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $BEEDOCS_API_KEY" \
  -d '{
    "book": {
      "title": "Application1",
      "slug": "application1",
      "description": "Runtime docs for Application1"
    },
    "page": {
      "title": "Configuration",
      "slug": "configuration",
      "content": "# Configuration\n\n| Key | Value |\n|-----|-------|\n| port | 8080 |\n"
    },
    "folder": {
      "title": "Gateways",
      "slug": "gateways"
    },
    "shelf": {
      "title": "Edge Services",
      "slug": "edge-services"
    }
  }'
```

`folder` is optional: when present, the page is placed inside that folder (chapter)
of the book — matched by slug and **created automatically when missing** (an existing
folder is used as-is; its title is not renamed). When omitted, an existing page keeps
its current folder and a new page lands at the book root.

`shelf` is optional and follows the same rules one level up: when present, the
book is placed on that shelf — matched by slug and **created automatically when
missing** (an existing shelf is used as-is; its title is not renamed). When
omitted, an existing book stays wherever it already sits and a new book lands at
the library root.

Response (`201` when something was created, `200` when both already existed):

```json
{
  "book": {
    "id": "…",
    "title": "Application1",
    "slug": "application1",
    "description": "Runtime docs for Application1",
    "sortOrder": 0,
    "ownerId": null,
    "ownerName": null,
    "createdAt": "…",
    "updatedAt": "…"
  },
  "page": {
    "id": "…",
    "bookId": "…",
    "title": "Configuration",
    "slug": "configuration",
    "content": "# Configuration\n\n…",
    "version": 1,
    "ownerId": null,
    "ownerName": null,
    "updatedById": null,
    "updatedByName": "API key",
    "createdAt": "…",
    "updatedAt": "…"
  },
  "bookCreated": true,
  "pageCreated": true
}
```

Omitting `slug` derives it from `title` (`Application1` → `application1`).

**Ownership and history.** Publishing never reassigns a document: a republish
leaves `ownerId` exactly as it was, and a book or page created through this API
is unowned unless an account is behind the call. Every write does append to the
page's change log — an API-key caller is recorded as `"API key"` rather than as a
person, since the key is not an account. See
[USERS-AND-ROLES.md](./USERS-AND-ROLES.md).

---

## Resources

### Discovery

```http
GET /api/v1
```

Returns a short description of the publish surface.

### Books

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/books` | List all books |
| `GET` | `/api/v1/books/{bookSlug}` | Get one book |
| `PUT` | `/api/v1/books/{bookSlug}` | Create or update book |
| `DELETE` | `/api/v1/books/{bookSlug}` | Delete book (and its pages) |

**Upsert body** (`PUT /api/v1/books/{bookSlug}`):

```json
{
  "title": "Application1",
  "description": "Optional summary",
  "sortOrder": 0
}
```

All fields optional. On create, missing `title` defaults to the path slug.

**Response:** `{ "item": { …book }, "created": true|false }`  
`201 Created` when new, `200 OK` when updated.

A book may sit on a **shelf** — the grouping level above books. This slug-based
book route never moves a book: republishing leaves its shelf untouched, and a
book created here lands at the library root. To shelve a book from the publish
surface, pass `shelf` on `PUT /api/v1/publish` (see the quick start); full shelf
management lives on the id-based API (`/api/shelves`, and `shelfId` on
`POST`/`PUT /api/books/{id}`), which is also what the workspace UI and the MCP
server use.

### Pages

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/books/{bookSlug}/pages` | List page summaries in a book |
| `GET` | `/api/v1/books/{bookSlug}/pages/{pageSlug}` | Get page (includes Markdown `content`) |
| `PUT` | `/api/v1/books/{bookSlug}/pages/{pageSlug}` | Create or update page |
| `DELETE` | `/api/v1/books/{bookSlug}/pages/{pageSlug}` | Delete page |

**Upsert body** (`PUT …/pages/{pageSlug}`):

```json
{
  "title": "Configuration",
  "content": "# Configuration\n\nYour markdown here…\n",
  "sortOrder": 0
}
```

- `content` is **required on create**; on update, omit it to leave the body unchanged.
- If the book does not exist yet, `PUT` on a page **auto-creates** the book from `{bookSlug}`.

**Response:** `{ "item": { …page }, "created": true|false }`

### Publish (book + page)

| Method | Path | Description |
|--------|------|-------------|
| `PUT` | `/api/v1/publish` | Ensure book (+ optional folder, + optional shelf) + write page (idempotent) |

See [Quick start](#quick-start--one-shot-publish). The response echoes `folder`
(and `folderCreated`) and `shelf` (and `shelfCreated`) when the request
specified them.

### Search

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/search?q=` | Full-text search across shelves, books, folders, pages and diagrams |

| Query param | Default | Description |
|-------------|---------|-------------|
| `q` | *(required)* | Search terms. `"quoted runs"` match as a phrase. |
| `limit` | `20` | Hits to return, capped at 100. |
| `offset` | `0` | Paging offset. |
| `bookSlug` | *(all books)* | Restrict to one book. 404 if the slug is unknown. |
| `kinds` | *(all)* | Comma-separated: `page`, `diagram`, `book`, `folder`, `shelf`. |
| `prefix` | `true` | Match the final term as a prefix, for as-you-type search. |

```http
GET /api/v1/search?q=payment%20gateway&kinds=page&limit=5
```

```json
{
  "query": "payment gateway",
  "total": 2,
  "limit": 5,
  "offset": 0,
  "engine": "fts5",
  "hits": [
    {
      "kind": "page",
      "id": "8f2c…",
      "title": "Payment Gateway",
      "snippet": "The checkout service talks to the payment gateway over gRPC…",
      "bookId": "cace…",
      "bookTitle": "Platform Architecture",
      "chapterId": null,
      "url": "/books/cace…/pages/8f2c…",
      "score": -1.87,
      "updatedAt": "2026-07-31T16:41:50Z"
    }
  ]
}
```

Matched terms in `snippet` are wrapped in `U+E000` / `U+E001` rather than HTML,
so the excerpt stays plain text and cannot inject markup into your renderer.
`score` is a bm25 rank — lower is a better match, and hits arrive sorted.

Query text is never interpreted as an expression, so user input can be passed
through verbatim. Terms are ANDed and diacritics fold (`cafe` finds `café`).

The index maintains itself: it is rebuilt from database triggers, so pages you
publish through this API are searchable on the next query with no extra call.
`GET /api/search/status` and `POST /api/search/reindex` (on the internal
surface) report and repair it.

---

## Bookshelf websites

A shelf can be served as a standalone reader site at
`/bookshelf-serve/{slug}` (the title also works — it is slugified). The UI is
read-only: books, folders and pages from that shelf only.

`shelf.published` controls whether the site is world-readable when sign-in is
on. Unpublished shelves still preview at the same URL for anyone who can
already read the workspace. When sign-in is off, every shelf URL works.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/bookshelf-serve/{name}` | Site tree (shelf + books + folders + page titles) |
| `GET` | `/api/bookshelf-serve/{name}/pages/{bookSlug}/{pageSlug}` | Page body |
| `GET` | `/api/bookshelf-serve/{name}/diagrams/{id}` | Diagram, if it belongs to a book on the shelf |
| `GET` | `/api/bookshelf-serve/{name}/search?q=` | Full-text search scoped to the shelf |

These routes are anonymous. An unpublished shelf answers `404` to a visitor
with no session (and does not leak that the slug exists). Publishing at least
one shelf also lets anonymous `GET /uploads` succeed, because page Markdown
embeds those URLs.

Set `published` on `POST /api/shelves` or `PUT /api/shelves/{id}` (`null` on
update leaves it alone).

---

## Slugs

Slugs are stable addresses for re-publishes:

- Lowercase, URL-safe (`Application 1` → `application-1`)
- Unique per book (pages) or globally (books)
- Prefer explicit slugs from your app (`application1`, `configuration`) so re-runs hit the same records

---

## Example: publish configuration from a service

```python
import os, json, urllib.request

API = os.environ.get("BEEDOCS_URL", "http://localhost:5080")
KEY = os.environ.get("BEEDOCS_API_KEY", "")

body = {
    "book": {"title": "Application1", "slug": "application1"},
    "page": {
        "title": "Configuration",
        "slug": "configuration",
        "content": "# Configuration\n\n```yaml\nport: 8080\n```\n",
    },
}

req = urllib.request.Request(
    f"{API}/api/v1/publish",
    data=json.dumps(body).encode(),
    headers={
        "Content-Type": "application/json",
        **({"Authorization": f"Bearer {KEY}"} if KEY else {}),
    },
    method="PUT",
)
with urllib.request.urlopen(req) as res:
    print(res.status, res.read().decode())
```

After publishing, open the BeeDocs UI — **Application1 → Configuration** appears in the library.

---

## Health

```http
GET /api/health
```

```json
{ "status": "ok", "service": "BeeDocs.Api", "version": "0.1.x" }
```

No API key required.

---

## Relation to other surfaces

| Surface | Audience | Notes |
|---------|----------|--------|
| **`/api/v1`** | External apps publishing docs | Slug-based, optional API key |
| **`/api/*`** | BeeDocs web UI | Id-based CRUD, diagrams, import/export |
| **MCP** | AI agents | Tools over HTTP/stdio — see [MCP-SERVER.md](./MCP-SERVER.md) |

---

## Configuration reference

| Key | Env | Default | Description |
|-----|-----|---------|-------------|
| `BeeDocs:ApiKey` | `BeeDocs__ApiKey` | _(empty)_ | Shared secret for `/api/v1` |
| `BeeDocs:DataPath` | `BeeDocs__DataPath` | `data/sqlite` | SQLite directory (`beedocs.db`) |
| `ConnectionStrings:Sqlite` | `ConnectionStrings__Sqlite` | _(derived)_ | Full SQLite connection string (overrides DataPath) |
| `BeeDocs:UploadsPath` | `BeeDocs__UploadsPath` | `data/uploads` | Image uploads |
| `BeeDocs:AttachmentsPath` | `BeeDocs__AttachmentsPath` | `data/attachments` | Book attachments (never served statically) |

K3S: add `BeeDocs__ApiKey` to the deployment secret/config if other services will call the API.

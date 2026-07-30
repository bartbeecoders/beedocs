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

Optional shared secret, configured on the API:

| Config | Env var | Purpose |
|--------|---------|---------|
| `BeeDocs:ApiKey` | `BeeDocs__ApiKey` | When set, every `/api/v1` request must authenticate |

Send either:

```http
Authorization: Bearer <api-key>
```

or

```http
X-Api-Key: <api-key>
```

- **Unset / empty** — `/api/v1` is open (local dev). The API logs a warning at startup.
- **Set** — missing or wrong key → `401 Unauthorized`.

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
    }
  }'
```

Response (`201` when something was created, `200` when both already existed):

```json
{
  "book": {
    "id": "…",
    "title": "Application1",
    "slug": "application1",
    "description": "Runtime docs for Application1",
    "sortOrder": 0,
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
    "createdAt": "…",
    "updatedAt": "…"
  },
  "bookCreated": true,
  "pageCreated": true
}
```

Omitting `slug` derives it from `title` (`Application1` → `application1`).

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
| `PUT` | `/api/v1/publish` | Ensure book + write page (idempotent) |

See [Quick start](#quick-start--one-shot-publish).

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
| `BeeDocs:DataPath` | `BeeDocs__DataPath` | `data/surreal` | SurrealDB store |
| `BeeDocs:UploadsPath` | `BeeDocs__UploadsPath` | `data/uploads` | Image uploads |

K3S: add `BeeDocs__ApiKey` to the deployment secret/config if other services will call the API.

# Users & roles

BeeDocs has accounts, three roles, and an opt-in sign-in wall. Accounts live in
the same SQLite file as the documents; passwords are stored as PBKDF2 hashes and
never leave the server.

---

## The switch

Sign-in is **off by default** (`BeeDocs:Auth:Enabled`). BeeDocs has always served
an open port behind whatever the deployment puts in front of it — Cloudflare
Access on the hosted instance, nothing at all on localhost — and turning that
into a login wall on upgrade would lock out every existing MCP client and reverse
proxy at once.

What the switch does **not** gate: the accounts themselves. The tables are
created, the admin is seeded, and `/api/users` works either way. Only
*enforcement* waits for the flag, so you can flip it (or flip it back) without a
migration.

| Setting | Default | What it does |
| --- | --- | --- |
| `BeeDocs:Auth:Enabled` | `false` | Require a signed-in account for `/api` and `/uploads` |
| `BeeDocs:Auth:SessionHours` | `168` (7 days) | Session lifetime. Sliding — a session past halfway is extended on use |
| `BeeDocs:Auth:SecureCookie` | unset | Force the `Secure` cookie flag. Unset = follow the request scheme |
| `BeeDocs:ApiKey` | unset | Shared secret for machines (MCP, publishing apps). Authenticates as **admin** |

Environment-variable form uses double underscores:

```bash
BeeDocs__Auth__Enabled=true
BeeDocs__Auth__SessionHours=168
BeeDocs__Auth__SecureCookie=true     # behind a TLS-terminating proxy
BeeDocs__ApiKey=$(openssl rand -hex 24)
```

**Set `SecureCookie: true` behind a proxy that terminates TLS.** Kestrel sees
plain HTTP from the proxy, so it would otherwise leave the flag off.

---

## The first admin

There is no seeded account and no generated password. An instance whose account
table is empty is **unclaimed**: with sign-in enabled, the browser shows a
one-time setup screen instead of the login form, and whoever fills it in becomes
the administrator with a password they chose.

```
┌─ Welcome to BeeDocs ────────────────┐
│ This instance has no accounts yet.  │
│ Create the administrator.           │
│                                     │
│ Username      [ admin          ]    │
│ Display name  [ Jane Doe       ]    │
│ Password      [ ••••••••••     ]    │
│ Repeat        [ ••••••••••     ]    │
│                                     │
│           [ Create account ]        │
└─────────────────────────────────────┘
```

Setup signs the new admin straight in — making someone re-type the password they
chose ten seconds ago proves nothing. Everyone else is added afterwards from
**Settings → Users & roles**.

Behind it, `POST /api/auth/setup` is open *only* while no account exists. The
emptiness check lives inside the `INSERT` (`… SELECT … WHERE NOT EXISTS (SELECT 1
FROM app_user)`) rather than in a separate query, so two people opening the setup
page at once cannot each be told the instance is theirs: one gets the account,
the other a `409`. Once any account exists the endpoint answers `409` forever.

> **Leave an unclaimed instance reachable and the first visitor becomes its
> admin.** The API logs a warning at every startup while it is unclaimed. Claim
> it before exposing it, or keep something in front of it — the hosted deployment
> sits behind Cloudflare Access, which decides who gets far enough to see the
> setup screen at all.

Sign-in **off** and no accounts is not "unclaimed" — an open instance never
needed an account. No setup screen appears; flip `BeeDocs:Auth:Enabled` on and
you get it on the next load.

Lost the only admin password? There is no recovery path by design: delete the
`app_user` rows and restart, and the instance is unclaimed again.

---

## Roles

Three fixed roles. There is no permission matrix to configure — a documentation
tool has three interesting answers to "what may this account do".

| Role | Read & search & export | Create / edit / delete content | Manage accounts, AI providers |
| --- | --- | --- | --- |
| **admin** | ✅ | ✅ | ✅ |
| **editor** | ✅ | ✅ | ❌ |
| **viewer** | ✅ | ❌ | ❌ |

New accounts default to **viewer** — the role that cannot break anything.

### How it is enforced

One endpoint filter in front of `/api` resolves the caller, then checks the role
against what the endpoint asks for. The default rule covers every content route:

- `GET` / `HEAD` / `OPTIONS` → any signed-in role
- everything else → **editor** or above

Endpoints that need more carry it explicitly: `/api/users/*` and the
`/api/llm/providers/*` settings are **admin**, reads included — a provider row
holds a paid credential, and the account list is who can reach the instance.

`POST /api/search/reindex` and `POST /api/import` land on the write side of the
default rule. That is deliberate: a viewer who cannot rebuild the search index
loses nothing.

The UI hides what the role cannot do — creation buttons, delete actions, the page
and diagram editors (viewers get the rendered document and a *Read-only* chip),
drag-to-reorder in the tree. That is cosmetic; the API refuses the calls whether
or not the button was drawn.

### Guard rails

The last enabled admin cannot be demoted, disabled, or deleted — losing it locks
everyone out of account management with no way back short of editing the database
by hand. The API answers `409 Conflict` with a sentence explaining what to do.

---

## Sessions

A session is an opaque 32-byte token in an `HttpOnly`, `SameSite=Lax` cookie
(`beedocs_session`). Only its SHA-256 is stored, so a copied database cannot be
replayed as a live login.

Sessions are dropped — everywhere, immediately — when the account is disabled or
deleted, when its password is changed by its owner, and when an admin resets it.
Changing your own password re-issues a cookie to the browser you did it in, so
you stay signed in there and nowhere else.

---

## Machines: MCP and publishing apps

An agent has no cookie. With sign-in enabled, non-browser clients authenticate
with `BeeDocs:ApiKey`, sent as `X-Api-Key: <key>` or `Authorization: Bearer
<key>`. That key authenticates a *machine*, not a person: it gets admin
authority, has no profile, and cannot change a password.

For the MCP server, pass the same value as `BEEDOCS_API_KEY`:

```bash
BEEDOCS_API_URL=http://localhost:5080 \
BEEDOCS_API_KEY=<the same value as BeeDocs__ApiKey> \
  dotnet run --project src/BeeDocs.Mcp
```

Note this is **not** `MCP_AUTH_TOKEN`, which guards the MCP server's own HTTP
transport. The two secrets protect different hops and should be different values.

If you enable sign-in without setting `BeeDocs:ApiKey`, the API logs a warning at
startup and every MCP call starts returning 401.

---

## Ownership

Books and pages each carry an **owner**: the account answerable for the
document. It is a responsibility field, not a permission — an owner grants no
extra rights, and any editor can still edit any page. Roles decide what you may
do; the owner records who it belongs to.

- A **book** takes the account that created it, unless the request names another.
- A **page** inherits its **book's** owner at creation, falling back to whoever
  created it when the book is unowned. It can be reassigned afterwards.
- Either can be **unassigned** (`null`) — which is what documents created by an
  API-key caller, or while sign-in was off, get. Documents that predate this
  feature stay unassigned until someone sets an owner.

Set it with the ordinary update call — `ownerId` follows the same convention as
every other optional field: omitted leaves it alone, `""` clears it.

```bash
curl -X PUT http://localhost:5080/api/books/<id> \
  -H 'Content-Type: application/json' \
  -d '{"title":"Platform architecture","ownerId":"<account id>"}'
```

Editors and admins can reassign; viewers see the owner and cannot change it.
`GET /api/users/directory` lists enabled accounts (id, username, display name,
role) for owner pickers — readable by every signed-in role, because you cannot
assign an owner you are not allowed to name.

Deleting an account does not delete or reassign what it owned. The owner id
stays, `ownerName` comes back null, and the UI shows *Unknown account* rather
than silently dropping the assignment.

## Page history

Every page keeps a change log: one entry per change, recording the version it
produced, when it happened, and who made it.

```
GET /api/pages/{id}/history?limit=25
```

```json
{
  "pageId": "…", "title": "System context", "version": 4,
  "entries": [
    { "version": 4, "title": "System context", "changeKind": "updated",
      "changedById": "…", "changedByName": "Administrator",
      "changedAt": "2026-08-10T17:54:09Z", "isCurrent": true },
    { "version": 1, "title": "Context", "changeKind": "created",
      "changedById": "…", "changedByName": "Eddie Editor",
      "changedAt": "2026-08-10T17:53:54Z", "isCurrent": false }
  ]
}
```

Entries are newest first, and the first one always matches the page's live
version — the log holds the state each change *left behind*, so reading it needs
no off-by-one. Each entry also stores the title and full content at that version,
which is what a future restore or diff would run on.

The author's display name is captured at the time of the change, so the log still
reads correctly after the account is renamed or deleted. `changedById` is null,
and `changedByName` reads `"API key"`, for changes made by a machine; both are
null for changes made while sign-in was off.

`changeKind` is `created`, `updated`, or **`legacy`**. Legacy entries come from
databases that predate the log: BeeDocs used to snapshot the state a page was
moving *away* from, so those rows hold the right content but their timestamp
marks when that version ended and no author was ever recorded. They are labelled
rather than reinterpreted. A page last edited before the upgrade also has no
entry for the version it is sitting on, so one is synthesised from the page
itself — with no author, because there genuinely is no record of one. The first
real save after upgrading starts the log properly.

Deleting a page (or a book) deletes its history with it.

## The API

Sign-in — anonymous by necessity, this is how a browser with no cookie finds out
whether it needs one:

| Route | Purpose |
| --- | --- |
| `GET /api/auth/me` | Is sign-in on, who am I, and is the instance still unclaimed (`setupRequired`)? Never 401s |
| `POST /api/auth/setup` | First-run claim: `{username, password, displayName?}`. `409` once any account exists |
| `POST /api/auth/login` | `{username, password}` → sets the cookie. 401 on failure |
| `POST /api/auth/logout` | Revokes this session and clears the cookie |
| `POST /api/auth/password` | `{currentPassword, newPassword}` — your own, any role |

Accounts — **admin only**, reads included:

| Route | Purpose |
| --- | --- |
| `GET /api/users/directory` | Enabled accounts, id and name only — for owner pickers. **Any signed-in role** |
| `GET /api/users` | List accounts |
| `GET /api/users/roles` | The three roles and what each may do |
| `POST /api/users` | Create. `role` defaults to `viewer` |
| `GET /api/users/{id}` | One account |
| `PUT /api/users/{id}` | Update — every field optional, omitted means unchanged |
| `DELETE /api/users/{id}` | Delete |
| `POST /api/users/{id}/password` | Admin reset. Omit `password` to have one generated and returned once |

`/api/health` and `/api/version` stay anonymous: a readiness probe that needs a
session reports the wrong thing.

Usernames are normalised (trimmed, lower-cased) and limited to letters, digits,
dot, underscore and hyphen, 2–64 characters. Passwords must be at least 8
characters. No response in the API ever carries a password hash; the only
response that carries a *password* is a generated reset, once.

---

## How passwords are stored

PBKDF2-HMAC-SHA256, 210,000 iterations (the OWASP floor), a 16-byte random salt
per user, 32-byte output. The stored string carries its own parameters:

```
pbkdf2-sha256$210000$<base64 salt>$<base64 hash>
```

So raising the iteration count later still verifies every password written before
the change, and each account is transparently upgraded on its next successful
sign-in. Verification is constant-time, and a login for an unknown username still
does the full derivation against a dummy hash — otherwise "no such account" would
be measurably faster than "wrong password" and the endpoint would be a username
oracle.

PBKDF2 rather than bcrypt or argon2 because it is in the BCL. BeeDocs.Api ships
with two NuGet references and no crypto dependency, and a password hash is a bad
place to take one on for a self-hosted app that must build offline.

---

## Schema

```sql
app_user(id, username UNIQUE, display_name, email, role, password_hash,
         enabled, must_change_password, last_login_at, created_at, updated_at)

user_session(token_hash PRIMARY KEY, user_id, created_at, expires_at, last_seen_at)

book(…, owner_id)          -- app_user.id, nullable
page(…, owner_id)          -- inherited from the book on create

page_revision(id, page_id, version, title, content,
              changed_by, changed_by_name, change_kind, created_at)
```

`owner_id` is deliberately **not** a foreign key: deleting an account must not
cascade into deleting its books. The columns are added to existing databases by
an `ALTER TABLE` step in `DatabaseInitializer` — `CREATE TABLE IF NOT EXISTS`
does nothing to a table that already exists.

`password_hash` is write-only in the same sense as `llm_provider.api_key`: it is
selected in exactly one place — the login and change-password paths, which
compare it and discard it — and never reaches a DTO.

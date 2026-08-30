# Git integration — repos as books on a shelf

BeeDocs can put git repositories next to its books: a **connection** (a GitHub
account/org, an Azure DevOps organization, or plain clone URLs) is the
bookshelf, each added **repo** is a book, and its folders and files browse and
render in the workspace — Markdown as pages, code with syntax colour, images
inline. Text files are **editable**: explicit Save writes the working tree,
Commit/Push/Pull and branch switching are deliberate toolbar verbs. History,
diffs and in-place conflict resolution are the next phase (see
`Vibecoding/git-information-integration.md`, the plan of record).

**Prefix:** `/api/git` · **Configured in:** Settings → **Git repositories** (admin)

## How it works

Repo content is **never imported into BeeDocs entities**. Each added repo is a
server-side clone under `BeeDocs:GitPath` (default `data/git/{repoId}`), and the
API answers tree/file/status/branch questions from that clone live — SQLite
holds only two management tables (`git_connection`, `git_repo`). The clone is
the source of truth; git history is the change log. That is why repos have no
owner field, no page revisions, no reader-site publishing and no exports.

Requirements: the `git` CLI on the API machine (the Dockerfile installs it;
local machines have it), and disk for the clones.

```
UI (GitTree/GitCanvas) → /api/git/* → GitRepoService → GitCli → git(1) → clone in data/git/{id}
                                        └ GitProviderCatalog → GitHub / DevOps REST (repo discovery)
```

## Connections

| Kind | Discovery | Base URL field | Auth |
|---|---|---|---|
| `github` | org/user repos via api.github.com | org or user name; blank = what the token can access | fine-grained PAT, Contents read |
| `azure-devops` | walks the org's projects → repos | `https://dev.azure.com/{org}` (one connection per organization) | PAT, Code (Read) |
| `git` | none — paste clone URLs | — | optional PAT for private remotes |

Only **https** clone URLs are accepted. Tokens are write-only
(`llm_provider.api_key`-style: stored in SQLite plain-text, selected only by
`GitConnectionService.ResolveAsync`, never in a DTO) and reach git as a
Basic `http.extraheader` passed through the `GIT_CONFIG_*` **environment** —
never argv (world-readable via /proc) and never a file on disk.

## Security posture (`Services/GitCli.cs`, `GitPaths`)

- Fixed `ArgumentList` invocations — user input is only ever an argument value.
- Hooks can never run (`core.hooksPath` → an empty dir), `file://` is refused,
  submodules are never recursed, credential prompts fail instead of hanging.
- Every client path is jailed: normalized, `..`/absolute/`.git` refused, and
  any segment that is a symlink refused — a crafted repo cannot serve `/etc`.
- Timeouts kill the whole process tree; one mutation at a time per repo
  (per-repo `SemaphoreSlim`).
- Roles: connections and repo add/remove are **admin**; Sync is **editor**
  (default write rule); reads are **viewer** (default read rule).

## Search

Per repo opt-in (the **Search** checkbox, `git_repo.indexed`). After every
successful clone/sync, `GitSearchIndexer` walks the clone (allow-listed text
extensions, ≤ 512 KB/file, ≤ 5000 files, `node_modules`/`bin`/`obj` skipped)
and rebuilds the repo's `search_doc` rows — kind `gitfile`, entity id
`{repoId}:{path}`, title = the path (so filename searches win the bm25 title
weight). Rows are written directly, **not** through `search_queue`, whose drain
treats unknown kinds as deletes; Reconcile ignores the kind for the same
reason. Hits deep-link to `/git/{repoId}/files/{path}` and show under
"Repository files" in Ctrl+K.

## Editing, committing, and the shared working copy

**Save ≠ commit.** A git file gets no autosave: **Save** (Ctrl+S) writes the
working tree via `PUT …/file`, guarded by `baseBlobSha` — the blob id the
editor loaded. If the file changed since (another save, a pull), the save is a
**409** and the message says to reload; an empty `baseBlobSha` means "create
this file" and 409s if one appeared. The toolbar then shows the dirty count,
and **Commit** opens a dialog (message + changed-file checklist). **Push** and
**Pull** are separate explicit buttons with ahead/behind badges.

Commit identity: **author** is the signed-in account — its display name plus
the **git email** each user sets for themselves under Settings → Your account
(`app_user.git_email`, self-service via `POST /api/auth/git-email`). A commit
without one is refused with guidance, never authored with a guess; history
reads *authored by the person, committed by BeeDocs* (committer
`BeeDocs <beedocs@beedocs.local>`). Machine callers (the MCP API key) and
instances with sign-in off commit as the platform.

**The working copy is shared instance state** — one checkout per repo, like a
shared drive. The rules keep that honest rather than hiding it:

- Checkout refuses (409) while anything is uncommitted.
- Pull merges; a conflicted merge is **backed out** (`merge --abort`) and
  reported with the file list — conflict markers never sit in a tree other
  people are reading. Undo one side and pull again; in-place resolution is a
  later phase.
- Push never forces; behind-the-remote is a 409 "pull first".
- Creating a branch (toolbar → New branch…) may carry uncommitted edits along —
  that is how an accidental main edit gets taken somewhere safe.

## Endpoints

```
GET/POST        /api/git/connections                admin
GET/PUT/DELETE  /api/git/connections/{id}           admin   (DELETE 409s while repos exist)
POST            /api/git/connections/{id}/test      admin   result in payload, storage-provider style
GET             /api/git/connections/{id}/available-repos  admin
POST            /api/git/connections/{id}/repos     admin   202-ish: row status=cloning, clone in background
GET             /api/git/repos                      viewer  (feeds the tree; poll while cloning)
GET/PUT/DELETE  /api/git/repos/{id}                 viewer/admin (PUT: name, indexed)
POST            /api/git/repos/{id}/pull            editor  merge pull + reindex (/sync is the phase-1 alias)
POST            /api/git/repos/{id}/push            editor  never --force; non-ff = 409
POST            /api/git/repos/{id}/commit          editor  {message, paths?}; author = acting user
PUT             /api/git/repos/{id}/file?path=      editor  {content, baseBlobSha}; stale sha = 409
POST            /api/git/repos/{id}/checkout        editor  {branch}; 409 while dirty
POST            /api/git/repos/{id}/branches        editor  {name, checkout?}; validated by check-ref-format
GET             /api/git/repos/{id}/tree?path=      viewer  one directory level
GET             /api/git/repos/{id}/file?path=      viewer  text inline (≤2 MB) + blobSha
GET             /api/git/repos/{id}/raw?path=       viewer  byte stream (images, downloads)
GET             /api/git/repos/{id}/status          viewer  branch, ahead/behind, dirty list (-uall)
GET             /api/git/repos/{id}/branches        viewer  local + remote-only (checkout DWIMs those)
```

`GitException` maps to 502 with a message phrased for the person fixing it;
`GitConflictException` — a stale save, push behind the remote, conflicted pull,
dirty checkout — maps to 409, because the fix is a user action, not a retry; a
path the jail refuses is a 400.

## Limits (on purpose)

The checked-out branch and dirty state are shared instance state (per-user
worktrees are a planned follow-up); no history/diff views yet; no in-place
conflict resolution; no file delete/rename from the UI; no ssh remotes,
submodules or LFS; binaries and >2 MB text render as Download. The plan
document carries the phased path to the rest.

# Git integration — repos as books on a shelf

BeeDocs can put git repositories next to its books: a **connection** (a GitHub
account/org, an Azure DevOps organization, or plain clone URLs) is the
bookshelf, each added **repo** is a book, and its folders and files browse and
render in the workspace — Markdown as pages, code with syntax colour, images
inline. Phase 1 is read-only browsing plus Sync; editing, commit, push/pull and
branch switching are the next phase (see `Vibecoding/git-information-integration.md`,
the plan of record).

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

## Endpoints

```
GET/POST        /api/git/connections                admin
GET/PUT/DELETE  /api/git/connections/{id}           admin   (DELETE 409s while repos exist)
POST            /api/git/connections/{id}/test      admin   result in payload, storage-provider style
GET             /api/git/connections/{id}/available-repos  admin
POST            /api/git/connections/{id}/repos     admin   202-ish: row status=cloning, clone in background
GET             /api/git/repos                      viewer  (feeds the tree; poll while cloning)
GET/PUT/DELETE  /api/git/repos/{id}                 viewer/admin (PUT: name, indexed)
POST            /api/git/repos/{id}/sync            editor  git pull --ff-only + reindex
GET             /api/git/repos/{id}/tree?path=      viewer  one directory level
GET             /api/git/repos/{id}/file?path=      viewer  text inline (≤2 MB) + blobSha
GET             /api/git/repos/{id}/raw?path=       viewer  byte stream (images, downloads)
GET             /api/git/repos/{id}/status          viewer  branch, ahead/behind, dirty list
GET             /api/git/repos/{id}/branches        viewer
```

`GitException` maps to 502 with a message phrased for the person fixing it; a
path the jail refuses is a 400.

## Limits (phase 1, on purpose)

Read-only working tree — no editing/commit/push yet; the checked-out branch is
shared instance state; no ssh remotes, submodules or LFS; binaries and >2 MB
text render as Download. The plan document carries the phased path to the rest.

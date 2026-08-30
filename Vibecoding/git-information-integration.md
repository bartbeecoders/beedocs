# Git information integration

> **Original request**
>
> Add the possibility to integrate git and/or MS devops accounts/repos.
> Idea is that the documents/code within the repos is accessible just like books on a bookshelf.
> The git account could be the bookshelf, the repos could be the books, files and folders could be documents and folders.
> Allow for changes through the editor, manage pulls, pushes, branches etc.
>
> Make a complete plan for this feature, start this in a new branch (feature/git-integration).
> Use this document to add your plan and thinking.

Branch: `feature/git-integration`. This document is the plan of record; implementation
notes get appended to the log at the bottom as phases land.

---

## 1. The concept, mapped to BeeDocs

| Git world | BeeDocs metaphor | What it actually is |
|---|---|---|
| Account / org / DevOps project | Bookshelf | A **git connection**: provider kind + URL + credential |
| Repository | Book | An **added repo**: a server-side clone BeeDocs manages |
| Folder | Chapter / folder | A tree node, listed on demand from the clone |
| File | Page / document | Rendered by type: Markdown as a page, code with highlighting, images inline |
| Branch / pull / push / commit | — (new) | A **git toolbar** on the repo: explicit, visible git verbs |

The bookshelf metaphor is a **UI metaphor, not a schema decision**. Repo content
does *not* become `book`/`page` rows — see the next section, which is the most
important call in this plan.

## 2. Architecture decision: a virtual tree, not imported entities

Two ways to make repo files "accessible like books":

**A. Import/sync** — mirror repo files into `book`/`chapter`/`page` rows and sync
both ways. Rejected:

- The repo is the source of truth; SQLite rows would be a cache pretending to be
  content. Every pull is a diff-and-reconcile against live rows, every save is a
  two-master conflict problem.
- Every existing subsystem would fire on rows that aren't really ours: search
  triggers, `page_revision` history (git *is* the history), favorites cleanup
  triggers, exports, the reader site, storage providers. Each needs a "but not
  git rows" carve-out — a permanent tax on every future feature.
- File ids churn with renames; a page id that survives a `git mv` needs rename
  detection in a sync layer. That is a hard problem we do not need to have.

**B. Virtual/federated (chosen)** — repo content lives only in a server-side
clone. The API serves the tree and file bodies on demand from that clone; edits
write to the working tree; commit/pull/push/branch are explicit operations on
it. The web app gets a parallel set of routes and canvases that *reuse the
rendering components* (Markdown view, syntax highlighting, image view) without
touching the document entities.

Precedents inside this repo point the same way:

- **Storage providers** already established "content bodies can live elsewhere,
  resolved at read time" — but they still own the tree in SQLite because shelf
  content *is* BeeDocs content. Git content is not; here the tree comes from
  the clone too.
- **`LlmCli`** (claude/grok CLI providers) established "the API may spawn a
  local, well-known CLI as a backend, with argv/stdin hygiene and process-tree
  kill on timeout". The git layer is the same pattern around the `git` binary.

Consequences to accept and document: git repos do not appear in Ctrl+K search
(until the opt-in indexing phase), are not exportable as PDF/DOCX books, cannot
be published as reader sites, and cannot hold BeeDiagram/slides/attachments.
All of that is correct — a repo is a window onto external content, not a book
BeeDocs authors.

## 3. Git execution layer

**Shell out to the `git` CLI** (`Services/GitCli.cs`, modelled on `LlmCli.cs`).
Not LibGit2Sharp: the CLI handles every transport/auth/proxy quirk of GitHub and
Azure DevOps, gets security fixes from the OS, and adds no native binary to the
build. Deployment requirement: `git` on the API image/PATH (the Dockerfile adds
one apk/apt package; local installs already have it).

Rules for every invocation:

- `ProcessStartInfo.ArgumentList` only (no shell, no string concat), fixed
  argument shapes per operation — user input only ever appears as a *value*
  (path, branch name, message), each validated first (see §9).
- **The token never appears in argv or in any file.** Credentials go through
  git's environment-config mechanism:
  `GIT_CONFIG_COUNT=1`, `GIT_CONFIG_KEY_0=http.extraheader`,
  `GIT_CONFIG_VALUE_0=Authorization: Basic <base64(user:PAT)>` — env vars are
  readable only by the same user/root, unlike `/proc/*/cmdline`. Works
  identically for GitHub, Azure DevOps and any HTTPS remote. The clone's stored
  remote URL is the clean URL, so nothing secret rests on disk.
- Hardening flags on every call: `-c core.hooksPath=<empty dir>` (never execute
  hook scripts), `-c protocol.file.allow=never`, no `--recurse-submodules`
  (submodules out of scope), `GIT_TERMINAL_PROMPT=0` so a bad credential fails
  instead of hanging on a prompt.
- Timeouts per operation class (clone/fetch minutes-scale like
  `ShelfContentMover`; tree/file reads seconds-scale), kill entire process tree
  on expiry, stderr tail surfaced in a `GitException` message phrased for the
  person who has to fix it (the `LlmException` convention).
- **Per-repo async lock** (a `SemaphoreSlim` per repo id): git does not tolerate
  concurrent mutations of one working tree. Reads of committed content go
  through plumbing (`git show`, `git ls-tree`) and can run concurrently;
  anything touching the working tree or refs queues.

Clones live under `BeeDocs:GitPath` (default `data/git/{repoId}`), a sibling of
the SQLite/uploads/attachments dirs, pointed at the same persistent volume in
containers. Deleting a repo row deletes the directory after the commit, the way
attachments do it.

## 4. Data model

Two tables, created by `DatabaseInitializer` like everything else. Content
columns stay out of SQLite entirely.

```
git_connection            -- the "bookshelf"
  id            TEXT PK
  kind          TEXT      -- github | azure-devops | git
  name          TEXT      -- display name ("bartbeecoders", "Contoso DevOps")
  base_url      TEXT      -- github: org/user URL or blank; devops: https://dev.azure.com/{org}[/{project}]; git: blank
  username      TEXT      -- for basic auth (devops: anything; github: token owner)
  token         TEXT      -- PAT, write-only, llm_provider-style (read only by ResolveAsync)
  created_at / updated_at

git_repo                  -- a "book" someone chose to put on the shelf
  id            TEXT PK
  connection_id TEXT FK -> git_connection (RESTRICT delete while repos exist)
  name          TEXT      -- repo name, tree label
  clone_url     TEXT      -- https clone URL
  default_branch TEXT     -- from the provider / HEAD after clone
  status        TEXT      -- cloning | ready | error (clone is minutes-scale, async)
  last_error    TEXT NULL
  fetched_at    TEXT NULL -- last successful fetch/pull
  created_at / updated_at
```

Deliberately **not** stored: branches, file lists, file bodies, dirty state —
all live in the clone and are asked for live. A connection's *available* repos
(the provider listing) are fetched on demand too, never persisted; only repos
the admin explicitly adds get a row and a clone. Cloning everything an account
can see would be a disk and PAT-scope hazard.

`GitConnectionService` follows `LlmProviderService` to the letter: token
write-only with `hasToken`/`tokenHint` in the DTO, null-leaves/""-clears on
update, delete refused (409) while repos reference it.

## 5. Provider kinds

All three end at the same place — an HTTPS clone URL plus a Basic-auth PAT — and
differ only in **repo discovery** and defaults:

| Kind | Repo discovery | Auth notes |
|---|---|---|
| `github` | `GET https://api.github.com/user/repos` / `/orgs/{org}/repos` (token as Bearer) | Fine-grained PAT, Contents read/write |
| `azure-devops` | `GET {org}/[{project}/]_apis/git/repositories?api-version=7.1` (PAT as Basic) | PAT scope: Code (Read & write) |
| `git` | none — the admin pastes clone URLs by hand | any HTTPS remote (GitLab, Gitea, Bitbucket…) work here today; first-class kinds later |

Discovery lives in `Services/GitProviderCatalog.cs` (one `HttpClient` via the
factory, same error-message discipline as `LlmClient`). "Test connection" =
run discovery (or `git ls-remote` for the generic kind) and report the count —
proves reachability and the credential without cloning anything.

## 6. API surface

New `/api/git` group in `Program.cs`, inside the existing `/api` auth gate.
Roles (see §10): connection/repo management admin, git verbs editor, reads
viewer.

```
GET/POST      /api/git/connections                     admin  (list has hasToken/tokenHint, never the token)
GET/PUT/DELETE/api/git/connections/{id}                admin
POST          /api/git/connections/{id}/test           admin  -> { ok, message, repoCount }
GET           /api/git/connections/{id}/available-repos admin -> provider listing, flag already-added

POST          /api/git/connections/{id}/repos          admin  -> creates row status=cloning, clones in background
GET           /api/git/repos                            viewer -> all repos grouped by connection (feeds the tree)
GET/DELETE    /api/git/repos/{id}                       viewer/admin

GET  /api/git/repos/{id}/tree?path=&ref=               viewer -> one level: [{name,type:file|dir,size,path}]
GET  /api/git/repos/{id}/file?path=&ref=               viewer -> {content|base64, blobSha, size, binary}
PUT  /api/git/repos/{id}/file?path=                    editor -> write to working tree; body carries baseBlobSha
GET  /api/git/repos/{id}/status                        viewer -> {branch, ahead, behind, dirty:[{path,state}]}
GET  /api/git/repos/{id}/branches                      viewer
POST /api/git/repos/{id}/branches                      editor -> create (+ optional checkout)
POST /api/git/repos/{id}/checkout                      editor -> refuse (409) while dirty
POST /api/git/repos/{id}/commit                        editor -> {message, paths?} author = acting user
POST /api/git/repos/{id}/pull                          editor -> ff/merge; conflict -> abort + 409 with file list
POST /api/git/repos/{id}/push                          editor -> never force; non-ff -> 409 "pull first"
GET  /api/git/repos/{id}/log?path=&n=                  viewer -> commit list (phase 3)
GET  /api/git/repos/{id}/diff?path=                    viewer -> working-tree diff (phase 3)
```

Reads of committed content use plumbing against `ref` (default: current
branch); only `file` PUT and `status` look at the working tree. File responses
are capped (2 MB text / 10 MB base64 — a repo can contain anything) with a
clear "too large, clone it locally" message beyond that.

## 7. Editing, commit and concurrency model

**Save ≠ commit.** The BeeDocs page editor autosaves every 1.5 s; a commit per
autosave would spam history into uselessness. Instead, git files get the git
mental model with training wheels:

1. **Save** (explicit, Ctrl+S — no autosave for git files) writes the working
   tree via `PUT …/file`, guarded by `baseBlobSha`: if the blob changed since
   the editor loaded it, 409 — the same optimistic-concurrency idea as
   `Artifact`-style publishes, not last-write-wins.
2. The repo's git toolbar shows the dirty count the moment anything differs.
3. **Commit** opens a dialog: changed-file checklist, message box (pre-filled
   `Update <file>` for a single file). Author is the signed-in account
   (`Name <email>`; accounts without an email get
   `login@users.beedocs.local`), committer identity is `BeeDocs`.
4. **Push** and **Pull** are separate explicit buttons with ahead/behind badges.

**v1 shares one working copy per repo** — the checked-out branch and dirty
state are instance-wide, exactly like a shared checkout on a file server.
Honest constraints instead of hidden merges: checkout refuses while dirty, pull
with a conflict aborts cleanly (`merge --abort`) and reports the files, push
never forces. The UI states plainly "branch and uncommitted changes are shared
by everyone on this server". Per-user worktrees (`git worktree` per account) is
the designed upgrade path, deliberately deferred (§13).

## 8. Web UI

**Settings → Git connections** — new `components/GitConnections.tsx` panel
reusing the `llm-*` card chrome (as `StorageProviders.tsx` already does): kind
tiles (GitHub / Azure DevOps / Any git URL), token write-only field with
hint, Test connection, and per-connection an "Add repositories" browser
(available-repos list with add buttons; plain URL input for the generic kind).

**Tree** — a "Repositories" section in the left pane under the library tree
(`components/GitTree.tsx`, sibling of `FavoritesPanel` + `NavTree`): connection
rendered shelf-style, repos book-style with a branch badge, folders lazy-expand
via `…/tree`, files as leaves with type icons. Rendered only when repos exist,
collapse state in localStorage — the `FavoritesPanel` conventions.

**Routes** — splat paths in `App.tsx`, rendered by `WorkspaceShell` like every
other canvas:

```
/git/:repoId                    -> GitRepoCanvas   (README render + status + toolbar)
/git/:repoId/files/*            -> GitFileCanvas   (the file at the splat path)
```

**GitFileCanvas** by extension: Markdown → existing `MarkdownView` (edit mode
swaps in a plain source editor with preview in v1; wiring the full
`HybridPageEditor` on top of a git-backed document source is phase 4 polish);
code/text → read view through the existing `syntaxHighlight.ts`, edit as plain
monospace textarea; images → inline; binaries → metadata + download. All git
canvases carry the **git toolbar**: branch picker, dirty count, Commit, Pull,
Push, Sync.

The properties pane shows repo/file facts (branch, remote, last fetch, blob
sha, size) — no owner/history machinery, that belongs to real pages.

**`WorkspaceContext` stays untouched.** Git state lives in its own
`GitContext` (repo list + per-repo status cache), so the flat `books` list and
everything hanging off it never learns about repos.

## 9. Security

- **Path traversal**: every `path` parameter is normalized and must resolve
  under the repo root (`Path.GetFullPath` prefix check), reject `..`, absolute
  paths, and paths whose parent chain contains a symlink; never serve `.git/`.
- **No secret in argv or on disk** (§3); token column write-only (§4); tokens
  live in the same plain-text-column regime as LLM keys — same documented
  file-permission stance, and the PAT scopes in §5 are the minimum, so a leaked
  token is a repo credential, not an account credential.
- **No hook execution, no submodules, no force push, terminal prompts off** (§3).
- **Injection**: branch names validated with `git check-ref-format`-equivalent
  rules before use; commit messages passed as argument values via
  `ArgumentList` (never `-m "..."` through a shell).
- **Role gates** as in §6; `/api/git` sits inside the `/api` filter so the
  sign-in wall and `BeeDocs:ApiKey` machine auth apply unchanged. The reader
  site (`/bookshelf-serve`) has no path to git content at all.
- **Resource limits**: response size caps (§6), clone timeout, one mutation at
  a time per repo (§3), repo add is admin-only so disk growth is a deliberate
  act.

## 10. Roles

| Action | Role |
|---|---|
| Browse repos, read files, status/branches/log | viewer |
| Save to working tree, commit, pull, push, branch create/switch | editor |
| Connections CRUD, test, add/remove repos | admin |

Rationale: pushing under the shared PAT is a content write, exactly what the
editor role means; wiring credentials and consuming disk is administration.

## 11. Search (opt-in, later phase)

Off by default — indexing a large repo is real I/O and most code noise. When a
repo opts in (`git_repo.indexed` flag): after each successful clone/pull, walk
text files under caps (extension allowlist, 1 MB/file, 10k files) and upsert
into `search_doc` with kind `gitfile` through the existing queue-drain
machinery; entity id = `{repoId}:{path}`, re-derived per sync (delete-then-add
for the repo — renames need no detection). Search hits deep-link to
`/git/{repoId}/files/{path}`. `AttachmentTextVersion`-style version stamp for
extractor upgrades.

## 12. MCP tools (later phase)

`BeeDocs.Mcp/Tools/GitTools.cs`, thin wrappers over §6 (the API key already
authenticates MCP as admin): `beedocs_git_list_repos`, `beedocs_git_tree`,
`beedocs_git_read_file`, `beedocs_git_status`, plus write verbs
(`write_file`, `commit`, `pull`, `push`, `branch`) — an agent can then draft
docs in a repo, commit and push, which is a genuinely strong story for this
product. Read tools first, write tools once the concurrency guards have
soaked.

## 13. Out of scope (deliberately, with upgrade paths)

- **Per-user worktrees** — v1 shares the checkout (§7); `git worktree` per
  account is the follow-up once demand is real.
- **Pull requests / work items** — v1 links out to the provider's PR page for
  the current branch; creating PRs via provider APIs is a later phase.
- **SSH remotes** — HTTPS+PAT covers GitHub/DevOps; SSH needs key management
  UX that PATs don't.
- **Submodules, LFS, force push, history rewriting** — refused/ignored in v1.
- **Webhooks/auto-fetch** — manual Sync button first; a poll interval or
  provider webhooks later.
- **First-class GitLab/Bitbucket kinds** — the generic `git` kind already
  clones them; discovery APIs can follow.

## 14. Implementation phases

**Phase 1 — connections & read-only browsing** *(vertical slice, shippable)*
- `DatabaseInitializer`: `git_connection`, `git_repo` tables.
- `Services/GitCli.cs` (runner + hardening + per-repo lock),
  `GitConnectionService`, `GitRepoService` (add→background clone→status),
  `GitProviderCatalog` (GitHub + DevOps discovery, generic `ls-remote` test).
- Endpoints: connections CRUD/test/available-repos; repos add/list/delete;
  tree/file/status/branches reads.
- Web: `GitConnections.tsx` settings panel, `GitContext`, `GitTree.tsx`,
  routes + `GitRepoCanvas`/`GitFileCanvas` (Markdown render, code highlight,
  images, size caps), Sync button.
- Docs: `Docs/GIT-INTEGRATION.md`, CLAUDE.md bullet, Dockerfile gets `git`.

**Phase 2 — the git verbs**
- `PUT file` with `baseBlobSha` guard; explicit-save editors (Markdown source +
  preview, code textarea); dirty status surfacing.
- commit / pull / push / branch create + checkout endpoints with the §7
  semantics and 409 conflict contracts; git toolbar + commit dialog; author
  identity from the session.

**Phase 3 — comfort**
- log + diff endpoints and views; conflict UX (list conflicted files, "keep
  mine/theirs" via checkout-stage helpers); opt-in search indexing (§11);
  read-only MCP tools.

**Phase 4 — power**
- MCP write tools; `HybridPageEditor` over a git document source; per-user
  worktrees; PR deep links; auto-fetch.

Each phase ends verified the repo's usual way: `dotnet build`, `tsc`/`eslint`,
and a curl/UI exercise against a scratch instance (no test project exists yet;
`GitCli` path/ref validation would be a good first real unit-test target).

## 15. Open questions for Bart

1. **Shared checkout acceptable for v1?** (§7 — single working copy, branch
   switching affects everyone on the instance.)

   ok for me

2. **Commit identity**: BeeDocs account name + email as author — is the
   `login@users.beedocs.local` fallback for email-less accounts OK, or should
   each user store a git email in their profile?

   each user need to have their own git email in the profile

3. **Azure DevOps shape**: connection per *organization* or per *project*?
   (Plan assumes org-level with optional project filter in `base_url`.)

   per oganisation

4. Is opt-in search indexing (§11) wanted early, or genuinely later?

   early

5. Any need to *render* non-Markdown docs richly (e.g. `.docx` in a repo), or
   is download enough there?

    download is ok (we can add the render later)

---

## Log

- 2026-08-30 — Plan written; branch `feature/git-integration` created. No code yet.
- 2026-08-30 — Bart's answers to §15 recorded in place: shared checkout OK for
  v1; commit identity needs a per-user git email in the profile (lands with
  Phase 2's commit work — `app_user` gets a `git_email` column then); DevOps
  per organization; search indexing pulled forward into Phase 1; download-only
  for rich docs.
- 2026-08-30 — **Phase 1 implemented** (read-only browsing + opt-in search):
  - Backend: `git_connection`/`git_repo` tables; `GitCli` (hardened runner +
    `GitPaths` jail), `GitConnectionService`, `GitRepoService` (background
    clone → status row, sync = `pull --ff-only`), `GitProviderCatalog`
    (GitHub + DevOps discovery, `ls-remote` test), `GitSearchIndexer`
    (kind `gitfile`, direct `search_doc` writes); `/api/git/*` endpoints;
    `gitfile` case in `SearchIndexService.BuildUrl`; Dockerfile installs git.
  - Web: Settings → Git repositories (`GitConnections.tsx`), left-pane
    "Repositories" section (`GitTree.tsx`, lazy folders), `/git/:repoId` +
    `/git/:repoId/files/*` canvases (`GitCanvas.tsx`: README/Markdown render,
    syntax-highlighted code, images, download; toolbar with branch,
    ahead/behind, dirty count, Sync), properties pane repo facts, `gitfile`
    group in Ctrl+K, `useGitRepos` store with clone polling.
  - Verified against a scratch instance: clone/status/tree/file (blob sha
    matches git's), sync, branches, GitHub discovery (octocat), search
    index + unindex, raw streaming, traversal guards (`../`, `.git` → 400),
    connection-delete refusal while repos exist, clone dir cleanup on delete.
  - Deviation from §6: reads have no `ref=` parameter yet (working tree only —
    ref-addressed reads arrive with history in Phase 3); `git.css` added.
- 2026-08-30 — **Phase 2 implemented** (the git verbs):
  - Identity: `app_user.git_email` (self-service `POST /api/auth/git-email`,
    Settings → Your account card, format-checked; also settable by admins via
    `UpdateUserRequest.GitEmail`). Commits are authored `Name <git_email>` with
    committer `BeeDocs <beedocs@beedocs.local>`; an account without a git email
    is refused with guidance (Bart's §15 answer — no fallback address). Machine
    callers / sign-in-off commit as the platform.
  - Backend: `PUT …/file` (baseBlobSha guard: stale save / create-over-existing
    / deleted-under-you all 409; atomic temp+move write; new files allowed),
    `POST …/commit` (path checklist or `add -A`, "nothing to commit" caught),
    `POST …/push` (`-u origin HEAD`, never force, behind = 409 "pull first"),
    `POST …/pull` (merge; conflicted merge backed out with the file list —
    `/sync` stays as alias), `POST …/checkout` (409 while dirty, DWIMs remote
    branches, reindexes), `POST …/branches` (create+switch, names validated by
    `check-ref-format` plus a leading-dash guard). `GitConflictException` → 409
    across the board; branch listing now includes remote-only branches; status
    uses `-uall` so the commit checklist names real files.
  - Web: toolbar grew a branch picker (with "New branch…" dialog), Pull, Push
    (↑n), and Commit (n) opening a message + file-checklist dialog; file
    canvases got explicit Edit/Save (Ctrl+S, unsaved-changes guard,
    Markdown preview toggle, 409 surfaced verbatim); `bumpGitStatus` store
    keeps toolbar/status in step; tree remounts per `fetchedAt` after pulls;
    Git identity card in Settings → Your account.
  - Verified against a local smart-HTTP remote (`git http-backend` wrapper) end
    to end: save/stale-409/new-file, commit gate → git email set → commit
    (author verified in the remote's log), push, external divergence → push 409
    → merge pull → push, both-sides conflict → 409 with file list and a clean
    tree after back-out, branch create/switch isolation, dirty-checkout 409,
    bad branch names 400.
  - Still open for later phases: history/diff views, in-place conflict
    resolution, file delete/rename, MCP tools, per-user worktrees.
- 2026-08-30 — **Phase 3 implemented** (comfort: history, diffs, conflict
  strategies, delete/rename, read-only MCP):
  - Backend: `GET …/log` (machine-parsed via unit separators; `path` follows
    renames with `--follow`; cap 200), `GET …/commits/{sha}` (meta + patch,
    256 KB cap), `GET …/diff` (vs HEAD; an untracked per-path target answers a
    synthetic all-added patch via `diff --no-index /dev/null`), `file?ref=`
    (plumbing reads via `show`; `ValidateRef` — charset-limited, no leading
    `-`/`.`, no `..` so a range can never reach `show`), `DELETE …/file` and
    `POST …/rename` (working-tree only, dirty until committed, rename onto an
    existing path 409s), and `pull?strategy=ours|theirs` (`-X` merge
    strategies — the answer a conflict 409 now points at).
  - Web: `DiffView` (plain-text unified-diff renderer), repo-canvas History
    (expandable commits with patches), file-canvas Changes/History panels,
    "view the file at this commit" read-only ref view with banner, Rename
    dialog and Delete, and Keep ours / Take theirs buttons appearing on a
    conflict 409.
  - MCP: `GitTools.cs` — eight read-only tools (`beedocs_git_list_repos`,
    `_tree`, `_read_file` (+ref), `_status`, `_branches`, `_log`,
    `_show_commit`, `_diff`), registered by assembly scan; `Docs/MCP-TOOLS.md`
    section added. Write verbs deliberately deferred per §12.
  - Verified live (local smart-HTTP remote + running MCP server): log whole /
    per-file with rename-follow, commit patch, file@ref (initial README), bad
    refs (`-x`, `a..b`, `main;rm`) → 400, tracked + untracked diffs, rename →
    conflict on existing target, delete → D in status → committed, conflict →
    plain pull 409 → `strategy=theirs` 200 with remote content winning → push;
    MCP `tools/list` shows all eight, `_log` and `_read_file@ref` answer
    correctly over stateless HTTP.
  - Phase 4 remains: MCP write verbs, per-user worktrees, PR deep links,
    auto-fetch, `HybridPageEditor` over a git document source.
- 2026-08-30 — **Phase 4 implemented** (power), with two deliberate deferrals:
  - **MCP write verbs**: eight more tools (`beedocs_git_write_file` with the
    blobSha guard, `_delete_file` (marked destructive), `_rename_file`,
    `_commit`, `_pull` (+strategy), `_push`, `_create_branch`, `_checkout`),
    thin wrappers over the phase-2/3 endpoints so every guard applies to
    agents unchanged. Descriptions teach the safe flow: branch → write →
    commit only your paths → push → a person reviews the PR — and switch
    back. `GitCommitRequest` gained `AuthorName`/`AuthorEmail`, honored only
    for machine callers (an agent naming its operator; a person's identity is
    their own and ignored for them).
  - **PR deep links**: the toolbar's PR ↗ opens the provider's
    create-pull-request page for the current branch (GitHub `compare/{branch}`,
    DevOps `pullrequestcreate?sourceRef=`), computed client-side — creating
    PRs via provider APIs stays a non-goal, the link is the hand-off.
  - **Auto-fetch**: `BeeDocs:GitFetchMinutes` (default 0 = off) arms
    `GitFetchService` — a background `git fetch` per ready repo under the
    per-repo lock; fetch only, so behind-badges stay honest while pulling
    remains a person's verb.
  - **Polish found in testing**: pull's merge commits are now committed as
    `BeeDocs <beedocs@beedocs.local>` (previously they picked up the host
    machine's global git config); `GitCli.Describe` names the right verb when
    `-c` pairs precede it. Markdown editing gained an Edit/Split/Preview
    switch (split = textarea + live preview side by side).
  - Verified live: MCP agent flow end-to-end against the local smart-HTTP
    remote (branch → create + sha-guarded edit → stale-sha 409 surfaced
    verbatim → commit authored "Doc Agent (for Bart)" with committer BeeDocs,
    confirmed in the remote's log → push → checkout back); auto-fetch cycle
    (behind 0 → external push → behind 1 after ~75 s, no manual pull);
    merge-commit identity confirmed as BeeDocs.
  - **Deferred, with rationale**: *per-user worktrees* — Bart accepted the
    shared checkout (§15.1) and the rework touches every endpoint, per-user
    disk, and the merge model; building it without real shared-checkout pain
    would be speculative architecture. *HybridPageEditor over a git source* —
    the editor is deeply coupled to pages (autosave, revisions, uploads,
    workspace context); the split view covers most of the value at none of
    the risk to the core editing path. Both stay on the books for a future
    phase driven by actual demand.
- 2026-08-30 — **AI actions on the repo context menu** (Bart's follow-up
  request): right-click a repo → Draft README / documentation / user manual /
  Summarize, generated by the configured LLM provider.
  - Backend: `LlmPrompts.DocDraft` — a sixth task whose context is a repo
    bundle and whose answer is a whole document (4096-token budget, 240 s
    timeout threaded through `LlmClient` so CLI providers can finish; the
    shared HttpClient backstop raised to 5 min). `GitAssistService` builds the
    bundle server-side (tree outline + excerpts scored
    most-informative-first: README → manifests → docs/*.md → shallow source;
    ≤ 40 KB total, ≤ 6 KB/file, binaries and vendored dirs skipped) and calls
    the ordinary `ILlmClient.CompleteAsync`, so every provider kind — the
    claude-cli/grok-cli ones included — works unchanged. `POST
    /api/git/repos/{id}/assist` (editor rule; a missing provider surfaces as
    its sentence, not a bare 404).
  - Web: repo context menu in `GitTree` (native `tree-context-*` chrome; Open
    / Pull / four ✨ items, write-gated) → `GitAssistDialog`: instructions →
    generate → rendered preview (source toggle, provider/tokens/grounding
    meta) → editable target path → save via the blob-guarded write, then
    navigate to the file. Discard/regenerate/copy included; nothing writes
    without review.
  - Verified live: no-provider case answers "No enabled LLM provider is
    configured."; with the claude-cli provider (model haiku) a README draft
    about the test repo generated in ~7 s, grounded in README.md +
    docs/todo.md (the result names its context files) and correctly derived
    from their contents.

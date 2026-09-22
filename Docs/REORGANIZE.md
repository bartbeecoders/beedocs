# AI reorganisation of a book or shelf

Right-click a book or a shelf in the library tree → **Reorganise with AI…**.
The configured (default) LLM provider reads every page and proposes a cleaner
structure: folders and reading order, clearer titles, overlapping pages merged,
duplicate pages archived, and hard-to-read pages rewritten more simply. You
review the proposal next to the current structure, untick what you disagree
with, and apply the rest.

Code: `src/BeeDocs.Api/Services/Reorganize/` (`ReorganizeService`, `ReorgText`),
DTOs in `Models/ReorgDtos.cs`, prompts `reorgplan` / `reorgmerge` in
`LlmPrompts` (`LlmClient.cs`), UI `components/ReorganizeDialog.tsx`.

## Flow

A job is one row in `reorg_job` and two background runs, on the same pattern as
the git AI jobs (fire-and-forget task, the row is the status, the dialog polls,
rows interrupted by a restart are swept to `failed` at startup):

```
queued → analyzing → proposed ──(person applies)──→ applying → applied
                  ↘ failed                                    ↘ failed
```

1. **Analyse.** The server snapshots the structure (books, folders, pages,
   `updated_at` of each page) and sends the model an outline with an excerpt of
   every page. Pages get short aliases (`p12`, books `b2`), which are cheaper
   and harder to garble than GUIDs. Excerpts share a ~100 k character budget
   evenly, and embedded blocks show up as `[embedded beediagram]`. The model
   answers in JSON (JSON response mode where the provider supports it; one
   retry if the answer is not JSON). The server then turns that answer into a
   proposal it can stand behind:
   - aliases are mapped back to real ids;
   - unknown ids and ids already used once are dropped (the first mention wins);
   - pages the plan doesn't mention are listed as "left as they are";
   - a merge of several sources is always a `merge`, and a "merge" with one
     source is a `keep`;
   - a merge or rewrite that involves a **grid-layout page** is turned into a
     plain move, because a rewrite would lose the page's cell markers.
2. **Review.** The dialog shows *Now* (the snapshot, with each affected page
   marked) next to *Proposed* (book → folders → pages, with badges for move,
   rename, merge and rewrite, where each page came from, and the AI's reason).
   Every change has a checkbox, and so do the duplicates and the book rename.
   Proposed pages that change nothing have no checkbox; they only keep their
   place in the new order.
3. **Apply.** The ticked items only. Moves and renames are ordinary page
   updates. A merge or rewrite makes one AI call per resulting page.

## Safety rails

- **Nothing is deleted.** A page merged into another, or archived as a
  duplicate, moves to an `Archive — reorganised YYYY-MM-DD` folder in its book.
  A note on top links to the page that now holds its content. A merge keeps the
  first source's page id, so links and history stay with it.
- **History keeps the old text.** Rewrites and merges are normal page updates,
  so page history holds the previous version.
- **Embedded blocks never reach the model.** Before a merge or rewrite, every
  fenced block (BeeDiagram JSON, kanban, spreadsheet, code, `*-ref` ids) is
  replaced by a `<<<BLOCK n>>>` line. The originals are put back byte for byte.
  A placeholder the model repeats is kept once; one it drops is appended at the
  end.
- **Truncation guard.** If the AI's version keeps fewer than 35 % of the
  source's words (for sources of 12+ words), it is refused and the item is
  left unchanged. This usually means the model was cut off or dropped content.
- **Oversize merges** (over 60 k characters of sources) are joined without the
  model, under `## Title` headings, so nothing is lost. Oversize rewrites are
  skipped.
- **Stale pages are skipped.** A page edited after the analysis is left alone,
  because the proposal was about text that no longer exists.
- **Links follow.** Links inside the scope that point at a moved page get its
  new book in the URL. Links to a merged-away or archived page point at the
  page that took over.
- **Folders.** Existing folders are reused by title. Folders that end the run
  empty (including new folders whose pages all failed) are removed. The emptiness
  check is raw SQL, so another user's private page still counts.
- **Privacy.** Private pages are never sent to the model or touched, since a
  merge could copy their text into a page everyone can read. In a shelf run,
  private books are left out too. Reads and writes run as the person who started
  the job (`AmbientActor`), so the normal privacy filter applies and page
  history names them.
- **One run per scope** at a time (409 otherwise). A proposal can be applied
  once (the `proposed → applying` flip is the lock).
- **Visibility.** A job (and its proposal, which quotes page titles) is visible
  only to its creator and admins. With sign-in off, everyone is admin.

Limits: 300 pages per analysis; reorganise a large shelf book by book.

## API

| Method | Path | Notes |
|---|---|---|
| POST | `/api/reorganize/jobs` | `{scope: "book"\|"shelf", scopeId, instructions?, providerId?, model?}`. Editor. 409 if a run is active for that scope. |
| GET | `/api/reorganize/jobs?scope=&scopeId=` | Newest first, without proposal bodies. |
| GET | `/api/reorganize/jobs/{id}` | With `proposal`, `current` (snapshot) and `log`. |
| POST | `/api/reorganize/jobs/{id}/apply` | `{items: ["i1",…], removals: ["r1",…], renameBooks: [bookId]}`. 409 unless `proposed`. |
| DELETE | `/api/reorganize/jobs/{id}` | Cancels a running analysis/apply. What was already applied stays. |

The apply log is written as it goes, so a run that stops part-way still shows
what it did.

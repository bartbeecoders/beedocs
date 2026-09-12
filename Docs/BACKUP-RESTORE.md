# Backup & restore

Settings → **Backup** lets an admin back up everything an instance holds to one
or more storage providers, on a schedule or on demand, and restore from any
archive. Storage providers are the same rows Settings → Storage manages
(Azure Blob Storage, Google Drive, and S3-compatible services), used here
through their binary, name-addressed side rather than the text-body side that
shelf offloading uses.

## What an archive holds

One zip, `backups/beedocs-YYYYMMDD-HHMMSSZ.zip` at every target:

| Entry | Contents | Optional |
|---|---|---|
| `manifest.json` | Format version, BeeDocs version, creation time, what was included | — |
| `sqlite/beedocs.db` | A consistent snapshot of the database (`VACUUM INTO`) | always |
| `uploads/**` | Uploaded images (`BeeDocs:UploadsPath`) | yes |
| `attachments/**` | Book attachments (`BeeDocs:AttachmentsPath`) | yes |
| `branding/**` | The instance logo (`BeeDocs:BrandingPath`) | yes |
| `offloaded/{table}/{id}` + `offloaded/index.json` | Content bodies that live at storage providers, fetched back in | yes |

The database snapshot is taken with `VACUUM INTO`, which produces a compacted,
transactionally consistent single-file copy while other connections keep
writing (WAL). Nothing is locked for the duration of the zip.

**Offloaded bodies** are the one part that is not on the server's disk. With
"Content stored at storage providers" on (the default), every row whose
`content_ref` points at a provider is fetched and written into the archive, so
a restore never depends on the provider still holding those objects. A fetch
that fails is recorded in the manifest (`offloadedErrors`) rather than failing
the backup — a backup with one unreachable body is worth more than no backup.

**Git clones are never archived.** They are re-clonable from their remotes and
can dwarf everything else. After a restore onto a server that lacks them, the
repos are marked `error` with a message telling the admin to remove and re-add
them.

The archive contains every credential the database does — provider secrets,
LLM keys, PATs, password hashes. Treat the bucket it lands in accordingly.

## Settings

Stored as JSON in `app_setting['backup.settings']`:

| Field | Meaning |
|---|---|
| `scheduleHours` | 0 = manual only; otherwise a backup starts whenever the newest backup row is older than this. |
| `providerIds` | Every archive is uploaded to each of these providers. A provider that is not ready fails its upload and the run records that per target. |
| `keepLast` | Per provider, after a successful upload, archives beyond the newest N under `backups/` are deleted. 0 keeps everything. |
| `includeUploads` / `includeAttachments` / `includeBranding` / `includeOffloaded` | What goes in besides the database. |

The scheduler (`BackupSchedulerService`) ticks once a minute and derives "due"
from the newest `backup_run` row rather than from timer state, so a restart or
a restore (which replaces the history) never loses or doubles a run. The same
computation is what Settings shows as the next scheduled backup.

## Runs and history

Every backup and restore is a row in `backup_run` (`kind`, `trigger`, `status`,
timestamps, who started it, the archive key, size, per-target outcomes as JSON,
and a message). One backup or restore runs at a time; a second request answers
409. A backup that reaches at least one target is `completed`; the per-target
list says which ones failed and why. Rows left `running` by a crash are marked
`failed` at the next startup.

The backup's own row is written only once its archive exists, so a snapshot
never carries a "running" row for the backup that produced it.

## Restore

A restore replaces the instance's database and files with the archive's. It is
started from Settings → Backup, either from an archive listed at a provider or
from a `.zip` uploaded from the admin's machine, and runs in the background
like a backup. What happens, in order:

1. The archive's manifest and database are extracted to the work directory and
   checked (`PRAGMA quick_check`, presence of the core tables) before anything
   live is touched.
2. The **maintenance gate** goes up: every `/api` call except the backup status
   and `/api/health` answers 503 with `Retry-After` until the restore is done.
   A page saved halfway through the copy would otherwise land in whichever of
   the two databases the write happened to reach.
3. Current sign-in sessions are snapshotted, and a safety copy of the current
   database is written to the work directory (`pre-restore-*.db`, newest only).
4. The database is copied in with SQLite's **online backup API** into the live
   connection: pages are replaced under SQLite's own locking, so no file is
   swapped beneath an open handle and the WAL cannot be left describing a
   database that no longer exists. Migrations (`EnsureSchemaAsync`) then run,
   so an archive from an older BeeDocs restores cleanly.
5. Sessions are re-inserted for accounts the restored database still knows and
   has enabled — the admin who clicked Restore keeps their session instead of
   being bounced to the login screen by their own action.
6. Offloaded bodies captured in the archive go back **inline** (`content_ref`
   cleared). The provider objects the restored rows point at may be gone; a row
   that carries its own body can never fail to load. The shelf keeps its
   provider, so the next save — or re-assigning the shelf's storage — offloads
   them again.
7. Each directory the manifest says was included is replaced: the archive's
   entries are extracted beside the target first (paths jailed under it), then
   swapped in. Directories the archive did not include are left alone.
8. Git repos whose clone directory is missing are marked `error`.
9. Every singleton that caches a row of the old database is invalidated (RBA
   settings, API key, branding, the storage-provider client cache), and the
   search index is re-initialised.
10. The gate drops, and the restore's own row is written into the (new)
    history.

The browser shows "Restore finished — reload" once the status endpoint reports
the run left `running`.

## Endpoints

All under `/api/settings/backup`, admin-only:

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Settings, providers with readiness, the run in progress, next scheduled time, history. Answers during a restore. |
| PUT | `/` | Save settings (full replace). |
| POST | `/run` | Start a backup → 202 `{runId}`, or 409 while one runs. |
| GET | `/export` | Build a fresh archive and stream it as a download. Nothing is uploaded or recorded. |
| GET | `/providers/{id}/archives` | Archives under `backups/` at that provider, newest first. |
| GET | `/providers/{id}/archives/{key}` | Stream one archive to the browser. |
| DELETE | `/providers/{id}/archives/{key}` | Delete one archive. |
| POST | `/restore` | `{providerId, key}` → 202 `{runId}`. |
| POST | `/restore/upload` | Multipart `.zip` → 202 `{runId}`. Not subject to the global request size cap. |

## Work directory

Archives are built and unpacked under `BeeDocs:BackupWorkPath` (default
`data/backup-work`, a sibling of the SQLite directory so container
deployments have it on the data volume rather than in `/tmp`). Scratch files
are removed after each run and swept at startup; the newest `pre-restore-*.db`
safety copy is kept.

## S3-compatible providers

The `s3` storage-provider kind covers AWS S3 and everything that speaks its
API (MinIO, Ceph RGW, Cloudflare R2, Backblaze B2, Wasabi, Hetzner …). Fields:
endpoint URL (blank = AWS, derived from the region), region (signing only;
`us-east-1` for most non-AWS services), bucket (must already exist), access
key id (echoed), secret access key (write-only), path-style addressing (on by
default whenever an endpoint is given — MinIO and most self-hosted services
need it; off for AWS), and an optional key prefix so one bucket can be shared.

`S3ContentStore` is a hand-rolled SigV4 client over `HttpClient` (PUT, GET,
DELETE, ListObjectsV2): the four verbs BeeDocs needs are a page of code, and
the self-hosted services this exists for are exactly where the AWS SDK's
defaults need the most overriding. Backup uploads sign the payload hash of the
file (or go `UNSIGNED-PAYLOAD` for a non-seekable stream); the store never
creates buckets.

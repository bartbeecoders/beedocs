using Microsoft.Data.Sqlite;

namespace BeeDocs.Api.Services;

public static class DatabaseInitializer
{
    public static async Task EnsureSchemaAsync(SqliteConnectionFactory factory, CancellationToken ct = default)
    {
        await using var connection = await factory.OpenConnectionAsync(ct);

        await using (var pragma = connection.CreateCommand())
        {
            pragma.CommandText = "PRAGMA journal_mode=WAL;";
            await pragma.ExecuteNonQueryAsync(ct);
        }

        await using var cmd = connection.CreateCommand();
        cmd.CommandText = """
            -- The level above books. Holds no content itself, so deleting one
            -- unshelves its books rather than cascading into them.
            CREATE TABLE IF NOT EXISTS shelf (
              id TEXT PRIMARY KEY NOT NULL,
              title TEXT NOT NULL,
              description TEXT,
              slug TEXT NOT NULL UNIQUE,
              sort_order INTEGER NOT NULL DEFAULT 0,
              -- 1 = /bookshelf-serve/{slug} is a public website. Default off so
              -- flipping Auth:Enabled does not suddenly publish every shelf.
              published INTEGER NOT NULL DEFAULT 0,
              owner_id TEXT,
              -- 1 = only the owner (and admins) can see this shelf. Default off
              -- so existing shelves stay shared. Mutually exclusive with published.
              is_private INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS book (
              id TEXT PRIMARY KEY NOT NULL,
              title TEXT NOT NULL,
              description TEXT,
              slug TEXT NOT NULL UNIQUE,
              sort_order INTEGER NOT NULL DEFAULT 0,
              -- shelf.id, or NULL for a book at the library root. Not a foreign
              -- key, for the same reason owner_id is not: the shelf going away
              -- must not take the book with it.
              shelf_id TEXT,
              -- app_user.id, or NULL when nobody was identified (sign-in off, or
              -- an API-key caller). Not a foreign key: deleting an account must
              -- not cascade into deleting its books.
              owner_id TEXT,
              is_private INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS chapter (
              id TEXT PRIMARY KEY NOT NULL,
              book_id TEXT NOT NULL,
              title TEXT NOT NULL,
              slug TEXT NOT NULL,
              sort_order INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS page (
              id TEXT PRIMARY KEY NOT NULL,
              book_id TEXT NOT NULL,
              chapter_id TEXT,
              title TEXT NOT NULL,
              slug TEXT NOT NULL,
              content TEXT NOT NULL DEFAULT '',
              sort_order INTEGER NOT NULL DEFAULT 0,
              version INTEGER NOT NULL DEFAULT 1,
              -- Defaults from the owning book when the page is created.
              owner_id TEXT,
              -- Change tracking, settable only by the page's owner or an admin:
              -- while on, old versions stay retrievable in full, capped at
              -- max_revisions copies (0 = unlimited).
              track_changes INTEGER NOT NULL DEFAULT 0,
              max_revisions INTEGER NOT NULL DEFAULT 0,
              is_private INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            -- The page's change log: one row per change, holding the state the
            -- page was left in. The newest row therefore mirrors the live page,
            -- and "who changed this, when" is a single ordered read.
            CREATE TABLE IF NOT EXISTS page_revision (
              id TEXT PRIMARY KEY NOT NULL,
              page_id TEXT NOT NULL,
              version INTEGER NOT NULL,
              title TEXT NOT NULL,
              content TEXT NOT NULL,
              -- app_user.id at the time, and the display name captured with it so
              -- the log still reads correctly after the account is renamed or
              -- deleted. Both NULL when nobody was identified.
              changed_by TEXT,
              changed_by_name TEXT,
              -- created | updated
              change_kind TEXT NOT NULL DEFAULT 'updated',
              created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS diagram (
              id TEXT PRIMARY KEY NOT NULL,
              book_id TEXT NOT NULL,
              page_id TEXT,
              title TEXT NOT NULL,
              kind TEXT NOT NULL,
              source TEXT NOT NULL DEFAULT '',
              owner_id TEXT,
              is_private INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            -- Slide decks (presentations). One JSON document per deck, same
            -- storage shape as diagram.source.
            CREATE TABLE IF NOT EXISTS slide_deck (
              id TEXT PRIMARY KEY NOT NULL,
              book_id TEXT NOT NULL,
              title TEXT NOT NULL,
              source TEXT NOT NULL DEFAULT '',
              owner_id TEXT,
              is_private INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            -- Kanban boards. One JSON document per board, same storage shape
            -- as slide_deck.source. card_count is maintained on every save so
            -- list projections never need the (possibly offloaded) source.
            CREATE TABLE IF NOT EXISTS kanban_board (
              id TEXT PRIMARY KEY NOT NULL,
              book_id TEXT NOT NULL,
              title TEXT NOT NULL,
              source TEXT NOT NULL DEFAULT '',
              content_ref TEXT,
              content_size INTEGER,
              card_count INTEGER NOT NULL DEFAULT 0,
              owner_id TEXT,
              is_private INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            -- Project plans (MS Project-style Gantt). One JSON document per plan.
            CREATE TABLE IF NOT EXISTS project_plan (
              id TEXT PRIMARY KEY NOT NULL,
              book_id TEXT NOT NULL,
              title TEXT NOT NULL,
              source TEXT NOT NULL DEFAULT '',
              content_ref TEXT,
              content_size INTEGER,
              task_count INTEGER NOT NULL DEFAULT 0,
              owner_id TEXT,
              is_private INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            -- Notes (OneNote-style free-form pages). One JSON document per note.
            CREATE TABLE IF NOT EXISTS note (
              id TEXT PRIMARY KEY NOT NULL,
              book_id TEXT NOT NULL,
              title TEXT NOT NULL,
              source TEXT NOT NULL DEFAULT '',
              content_ref TEXT,
              content_size INTEGER,
              block_count INTEGER NOT NULL DEFAULT 0,
              owner_id TEXT,
              is_private INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            -- Slide deck templates. App-wide (no book_id): a layout saved from
            -- one deck is meant to seed decks in any book. Not search-indexed —
            -- templates are scaffolding, not content someone looks for by text.
            CREATE TABLE IF NOT EXISTS slide_template (
              id TEXT PRIMARY KEY NOT NULL,
              name TEXT NOT NULL,
              source TEXT NOT NULL DEFAULT '',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            -- Files kept alongside a book's pages (PDF, Word, PowerPoint, …).
            -- Only metadata: the bytes live on disk under BeeDocs:AttachmentsPath,
            -- named stored_name, which is why there is no content_ref here — an
            -- opaque binary is not something a storage provider offload covers.
            CREATE TABLE IF NOT EXISTS attachment (
              id TEXT PRIMARY KEY NOT NULL,
              book_id TEXT NOT NULL,
              title TEXT NOT NULL,
              description TEXT,
              -- What a download is served as; stored_name is {id}{ext} on disk.
              file_name TEXT NOT NULL,
              stored_name TEXT NOT NULL,
              content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
              size_bytes INTEGER NOT NULL DEFAULT 0,
              -- Defaults from the owning book, then from the uploader. Not a
              -- foreign key, for the same reason book.owner_id is not.
              owner_id TEXT,
              is_private INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS shape_collection (
              id TEXT PRIMARY KEY NOT NULL,
              book_id TEXT,
              name TEXT NOT NULL,
              description TEXT,
              source TEXT NOT NULL DEFAULT '',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            -- LLM providers. api_key is write-only: it is read here to sign an
            -- upstream call and never leaves LlmProviderService any other way.
            CREATE TABLE IF NOT EXISTS llm_provider (
              id TEXT PRIMARY KEY NOT NULL,
              kind TEXT NOT NULL,
              name TEXT NOT NULL,
              base_url TEXT NOT NULL,
              api_key TEXT,
              model TEXT NOT NULL DEFAULT '',
              enabled INTEGER NOT NULL DEFAULT 1,
              sort_order INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            -- Storage providers for shelf content offloading. The secret columns
            -- (azure_connection_string, google_client_secret, google_refresh_token)
            -- are write-only in the llm_provider.api_key sense: read only inside
            -- StorageProviderService to reach the backend, never put in a DTO.
            -- Not search-indexed — configuration, not content.
            CREATE TABLE IF NOT EXISTS storage_provider (
              id TEXT PRIMARY KEY NOT NULL,
              kind TEXT NOT NULL,
              name TEXT NOT NULL,
              azure_connection_string TEXT,
              azure_container TEXT,
              google_client_id TEXT,
              google_client_secret TEXT,
              -- Written only by the OAuth callback.
              google_refresh_token TEXT,
              -- Drive folder ensured on connect; content objects live inside it.
              google_folder_id TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            -- Instance settings an admin can change at runtime from the Settings
            -- page — one row per key. The /api/v1 publish key lives here (its
            -- value is write-only, same rule as llm_provider.api_key); the
            -- BeeDocs:ApiKey configuration value is only a fallback.
            CREATE TABLE IF NOT EXISTS app_setting (
              key TEXT PRIMARY KEY NOT NULL,
              value TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            -- Backup and restore history (Settings → Backup). One row per run;
            -- targets is a JSON list of per-provider outcomes, so a backup
            -- that reached two of three providers is recorded as exactly that.
            -- Not search-indexed. A restore replaces this table along with the
            -- rest of the database, so the row for the restore itself is
            -- re-inserted after the copy — see BackupService.
            CREATE TABLE IF NOT EXISTS backup_run (
              id TEXT PRIMARY KEY NOT NULL,
              -- backup | restore
              kind TEXT NOT NULL,
              -- manual | scheduled
              trigger TEXT NOT NULL,
              -- running | completed | failed
              status TEXT NOT NULL,
              started_at TEXT NOT NULL,
              finished_at TEXT,
              started_by TEXT,
              archive_key TEXT,
              size_bytes INTEGER,
              targets TEXT,
              message TEXT
            );

            -- Accounts. password_hash is write-only in the same sense as
            -- llm_provider.api_key: UserService selects it to verify one login and
            -- no DTO carries it. The table exists whether or not sign-in is
            -- enforced, so BeeDocs:Auth:Enabled can be flipped without a migration.
            CREATE TABLE IF NOT EXISTS app_user (
              id TEXT PRIMARY KEY NOT NULL,
              username TEXT NOT NULL,
              display_name TEXT,
              email TEXT,
              role TEXT NOT NULL DEFAULT 'viewer',
              password_hash TEXT NOT NULL,
              enabled INTEGER NOT NULL DEFAULT 1,
              must_change_password INTEGER NOT NULL DEFAULT 0,
              last_login_at TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            -- Usernames are stored normalised (trimmed, lower-cased), so a plain
            -- UNIQUE index is already the case-insensitive constraint.
            CREATE UNIQUE INDEX IF NOT EXISTS idx_app_user_username ON app_user(username);

            -- One row per signed-in browser, keyed by the SHA-256 of the cookie
            -- token — the raw token exists only in the cookie, so a copied
            -- database cannot be replayed as a live session.
            CREATE TABLE IF NOT EXISTS user_session (
              token_hash TEXT PRIMARY KEY NOT NULL,
              user_id TEXT NOT NULL,
              created_at TEXT NOT NULL,
              expires_at TEXT NOT NULL,
              last_seen_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_user_session_user ON user_session(user_id);

            CREATE INDEX IF NOT EXISTS idx_page_book ON page(book_id);
            CREATE INDEX IF NOT EXISTS idx_chapter_book ON chapter(book_id);
            CREATE INDEX IF NOT EXISTS idx_diagram_book ON diagram(book_id);
            CREATE INDEX IF NOT EXISTS idx_diagram_page ON diagram(page_id);
            CREATE INDEX IF NOT EXISTS idx_slide_deck_book ON slide_deck(book_id);
            CREATE INDEX IF NOT EXISTS idx_kanban_board_book ON kanban_board(book_id);
            CREATE INDEX IF NOT EXISTS idx_project_plan_book ON project_plan(book_id);
            CREATE INDEX IF NOT EXISTS idx_note_book ON note(book_id);
            CREATE INDEX IF NOT EXISTS idx_attachment_book ON attachment(book_id);
            CREATE INDEX IF NOT EXISTS idx_shape_collection_book ON shape_collection(book_id);
            CREATE INDEX IF NOT EXISTS idx_page_revision_page ON page_revision(page_id);

            -- Search: the indexed projection of every searchable entity. Rows are
            -- written by SearchIndexService, which owns the plain-text extraction.
            CREATE TABLE IF NOT EXISTS search_doc (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              kind TEXT NOT NULL,
              entity_id TEXT NOT NULL,
              book_id TEXT,
              chapter_id TEXT,
              title TEXT NOT NULL DEFAULT '',
              body TEXT NOT NULL DEFAULT '',
              updated_at TEXT NOT NULL,
              indexed_at TEXT NOT NULL,
              UNIQUE (kind, entity_id)
            );

            CREATE INDEX IF NOT EXISTS idx_search_doc_book ON search_doc(book_id);

            -- Work list of entities whose index row is stale. Filled by triggers on
            -- the source tables so every writer is covered — the REST API, the MCP
            -- server, bulk imports, and anything that reaches the file directly —
            -- and drained by SearchIndexService, which is where a row can actually
            -- be turned into text.
            CREATE TABLE IF NOT EXISTS search_queue (
              kind TEXT NOT NULL,
              entity_id TEXT NOT NULL,
              op TEXT NOT NULL,
              queued_at TEXT NOT NULL,
              PRIMARY KEY (kind, entity_id)
            );

            -- A caller's starred items, shown in the workspace's favorites panel.
            -- kind reuses the search queue's names: book | page | diagram | slides
            -- | attachment. user_id is app_user.id, or '' when nobody was
            -- identified (sign-in off, or the API key) — it is half the primary
            -- key, so unlike owner_id it cannot be NULL, and '' gives an open
            -- instance one shared list, matching how ownership degrades
            -- elsewhere. Not a foreign key, like every user reference here.
            CREATE TABLE IF NOT EXISTS favorite (
              user_id TEXT NOT NULL,
              kind TEXT NOT NULL,
              entity_id TEXT NOT NULL,
              created_at TEXT NOT NULL,
              PRIMARY KEY (user_id, kind, entity_id)
            );

            -- The cleanup triggers below delete by target, across every user.
            CREATE INDEX IF NOT EXISTS idx_favorite_entity ON favorite(kind, entity_id);

            -- Git integration: a connection is an account/org plus a credential
            -- ("the bookshelf"), a repo is a server-side clone under
            -- BeeDocs:GitPath ("a book"). token is write-only in the
            -- llm_provider.api_key sense. Repo content is never rows here —
            -- the clone is the source of truth and is read live.
            CREATE TABLE IF NOT EXISTS git_connection (
              id TEXT PRIMARY KEY NOT NULL,
              kind TEXT NOT NULL,
              name TEXT NOT NULL,
              base_url TEXT NOT NULL DEFAULT '',
              username TEXT NOT NULL DEFAULT '',
              token TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS git_repo (
              id TEXT PRIMARY KEY NOT NULL,
              connection_id TEXT NOT NULL,
              name TEXT NOT NULL,
              clone_url TEXT NOT NULL,
              default_branch TEXT NOT NULL DEFAULT '',
              -- cloning | ready | error. The clone runs in the background.
              status TEXT NOT NULL DEFAULT 'cloning',
              last_error TEXT,
              -- 1 = text files feed search_doc rows of kind 'gitfile' on every
              -- successful clone/sync. GitSearchIndexer writes those directly —
              -- the search_queue drain would read an unknown kind as a delete.
              indexed INTEGER NOT NULL DEFAULT 0,
              fetched_at TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_git_repo_connection ON git_repo(connection_id);

            CREATE TABLE IF NOT EXISTS git_assist_job (
              id TEXT PRIMARY KEY NOT NULL,
              repo_id TEXT NOT NULL,
              -- readme | documentation | manual | summary | book (GitAssistService.Kinds).
              kind TEXT NOT NULL,
              instructions TEXT,
              provider_id TEXT,
              model TEXT,
              -- queued | running | completed | failed. Generation runs in the
              -- background (LLM calls are minutes-scale); the row is the status.
              status TEXT NOT NULL DEFAULT 'queued',
              error TEXT,
              -- The generated Markdown stays on the job even when publishing
              -- fails, so a completed draft is never lost to a bad shelf id.
              markdown TEXT,
              provider_name TEXT,
              model_used TEXT,
              prompt_tokens INTEGER,
              completion_tokens INTEGER,
              elapsed_ms INTEGER,
              context_files TEXT,
              -- 1 = publish the result into the library when generation ends.
              publish_book INTEGER NOT NULL DEFAULT 0,
              shelf_id TEXT,
              -- Once published, the created/updated targets — a re-run updates
              -- the same page in place (a new revision) instead of forking.
              book_id TEXT,
              page_id TEXT,
              created_by TEXT,
              created_by_name TEXT,
              created_at TEXT NOT NULL,
              started_at TEXT,
              finished_at TEXT,
              updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_git_assist_job_repo ON git_assist_job(repo_id);

            -- Jobs are about a repo; when the repo goes, its job history goes too
            -- (search-queue trigger style, so every writer is covered).
            CREATE TRIGGER IF NOT EXISTS trg_git_repo_assist_job_delete AFTER DELETE ON git_repo BEGIN
              DELETE FROM git_assist_job WHERE repo_id = OLD.id;
            END;
            """;

        await cmd.ExecuteNonQueryAsync(ct);

        // CREATE TABLE IF NOT EXISTS does nothing to a table that already exists,
        // so columns added after a release reach existing databases only here.
        // Ordered before the indexes below, which reference them.
        await AddColumnIfMissingAsync(connection, "book", "owner_id", "TEXT", ct);
        // NULL is "at the library root", which is where every book in an existing
        // database already is — so the migration needs no backfill.
        await AddColumnIfMissingAsync(connection, "book", "shelf_id", "TEXT", ct);
        await AddColumnIfMissingAsync(
            connection, "shelf", "published", "INTEGER NOT NULL DEFAULT 0", ct);
        await AddColumnIfMissingAsync(connection, "page", "owner_id", "TEXT", ct);
        // Off and unlimited: exactly how every page behaved before the feature,
        // so the migration needs no backfill.
        await AddColumnIfMissingAsync(
            connection, "page", "track_changes", "INTEGER NOT NULL DEFAULT 0", ct);
        await AddColumnIfMissingAsync(
            connection, "page", "max_revisions", "INTEGER NOT NULL DEFAULT 0", ct);
        await AddColumnIfMissingAsync(connection, "page_revision", "changed_by", "TEXT", ct);
        await AddColumnIfMissingAsync(connection, "page_revision", "changed_by_name", "TEXT", ct);
        // 'legacy', not 'updated', on the migration path only. Rows written before
        // the change log existed hold the state a page was moved *away* from, so
        // their timestamp is when that version ended rather than when it began and
        // their author is unknowable. Labelling them lets the history view show
        // them as earlier revisions instead of misreporting who changed what when.
        // Every insert names its own kind, so this default never touches a new row.
        await AddColumnIfMissingAsync(
            connection, "page_revision", "change_kind", "TEXT NOT NULL DEFAULT 'legacy'", ct);
        // Storage offloading. NULL content_ref is "body inline in content/source",
        // which is exactly where every existing row's body already is — so the
        // migration needs no backfill. NULL shelf.storage_provider_id is local
        // SQLite for the same reason.
        await AddColumnIfMissingAsync(connection, "shelf", "storage_provider_id", "TEXT", ct);
        // S3-compatible providers: sparse per-kind columns like the Azure/Google
        // ones, so the write-only rule for s3_secret_key stays greppable.
        await AddColumnIfMissingAsync(connection, "storage_provider", "s3_endpoint", "TEXT", ct);
        await AddColumnIfMissingAsync(connection, "storage_provider", "s3_region", "TEXT", ct);
        await AddColumnIfMissingAsync(connection, "storage_provider", "s3_bucket", "TEXT", ct);
        await AddColumnIfMissingAsync(connection, "storage_provider", "s3_access_key", "TEXT", ct);
        await AddColumnIfMissingAsync(connection, "storage_provider", "s3_secret_key", "TEXT", ct);
        await AddColumnIfMissingAsync(connection, "storage_provider", "s3_path_style", "INTEGER NOT NULL DEFAULT 1", ct);
        await AddColumnIfMissingAsync(connection, "storage_provider", "s3_prefix", "TEXT", ct);
        await AddColumnIfMissingAsync(connection, "page", "content_ref", "TEXT", ct);
        await AddColumnIfMissingAsync(connection, "page", "content_size", "INTEGER", ct);
        await AddColumnIfMissingAsync(connection, "page_revision", "content_ref", "TEXT", ct);
        await AddColumnIfMissingAsync(connection, "page_revision", "content_size", "INTEGER", ct);
        await AddColumnIfMissingAsync(connection, "diagram", "content_ref", "TEXT", ct);
        await AddColumnIfMissingAsync(connection, "diagram", "content_size", "INTEGER", ct);
        await AddColumnIfMissingAsync(connection, "slide_deck", "content_ref", "TEXT", ct);
        await AddColumnIfMissingAsync(connection, "slide_deck", "content_size", "INTEGER", ct);
        // NULL = "derive from source"; SlideDeckService backfills once at startup
        // and every save maintains it, so list projections never load the body.
        await AddColumnIfMissingAsync(connection, "slide_deck", "slide_count", "INTEGER", ct);
        // Git commit author identity. Deliberately separate from `email`: the
        // account email is contact data, this one ends up in public git history,
        // and each user chooses it themselves (Settings → Your account). NULL
        // means "not set" — commits are refused with guidance, never guessed.
        await AddColumnIfMissingAsync(connection, "app_user", "git_email", "TEXT", ct);
        // Owner-only visibility. 0 is "shared", which is how every existing row
        // behaved, so the migration needs no backfill. owner_id on diagram-like
        // rows is filled from the book on create going forward; existing rows
        // stay unowned (and therefore cannot be made private until assigned).
        await AddColumnIfMissingAsync(
            connection, "shelf", "is_private", "INTEGER NOT NULL DEFAULT 0", ct);
        await AddColumnIfMissingAsync(
            connection, "book", "is_private", "INTEGER NOT NULL DEFAULT 0", ct);
        await AddColumnIfMissingAsync(
            connection, "page", "is_private", "INTEGER NOT NULL DEFAULT 0", ct);
        await AddColumnIfMissingAsync(connection, "diagram", "owner_id", "TEXT", ct);
        await AddColumnIfMissingAsync(
            connection, "diagram", "is_private", "INTEGER NOT NULL DEFAULT 0", ct);
        await AddColumnIfMissingAsync(connection, "slide_deck", "owner_id", "TEXT", ct);
        await AddColumnIfMissingAsync(
            connection, "slide_deck", "is_private", "INTEGER NOT NULL DEFAULT 0", ct);
        await AddColumnIfMissingAsync(connection, "kanban_board", "owner_id", "TEXT", ct);
        await AddColumnIfMissingAsync(
            connection, "kanban_board", "is_private", "INTEGER NOT NULL DEFAULT 0", ct);
        await AddColumnIfMissingAsync(connection, "project_plan", "owner_id", "TEXT", ct);
        await AddColumnIfMissingAsync(
            connection, "project_plan", "is_private", "INTEGER NOT NULL DEFAULT 0", ct);
        await AddColumnIfMissingAsync(
            connection, "attachment", "is_private", "INTEGER NOT NULL DEFAULT 0", ct);
        await AddColumnIfMissingAsync(connection, "note", "owner_id", "TEXT", ct);
        await AddColumnIfMissingAsync(
            connection, "note", "is_private", "INTEGER NOT NULL DEFAULT 0", ct);

        await using (var indexes = connection.CreateCommand())
        {
            indexes.CommandText = """
                -- History reads newest-first, and a page's "last changed by" is
                -- the row matching its current version.
                CREATE INDEX IF NOT EXISTS idx_page_revision_page_version ON page_revision(page_id, version DESC);
                CREATE INDEX IF NOT EXISTS idx_book_owner ON book(owner_id);
                CREATE INDEX IF NOT EXISTS idx_page_owner ON page(owner_id);
                CREATE INDEX IF NOT EXISTS idx_attachment_owner ON attachment(owner_id);
                CREATE INDEX IF NOT EXISTS idx_book_shelf ON book(shelf_id);
                CREATE INDEX IF NOT EXISTS idx_shelf_owner ON shelf(owner_id);
                """;
            await indexes.ExecuteNonQueryAsync(ct);
        }

        await using (var triggers = connection.CreateCommand())
        {
            triggers.CommandText = QueueTriggerSql + FavoriteTriggerSql;
            await triggers.ExecuteNonQueryAsync(ct);
        }

        // Assist jobs run as in-process tasks, so a job still queued or running
        // in the database can only be a leftover from a process that died —
        // marked failed here rather than left "running" forever.
        await using (var sweep = connection.CreateCommand())
        {
            sweep.CommandText = """
                UPDATE git_assist_job
                SET status = 'failed',
                    error = 'Interrupted by a server restart — run it again.',
                    finished_at = $now,
                    updated_at = $now
                WHERE status IN ('queued', 'running')
                """;
            SqliteHelpers.Add(sweep, "$now", SqliteHelpers.FormatTimestamp(DateTimeOffset.UtcNow));
            await sweep.ExecuteNonQueryAsync(ct);
        }
    }

    /// <summary>
    /// <c>ALTER TABLE … ADD COLUMN</c>, but only when the column is genuinely
    /// missing — SQLite has no <c>IF NOT EXISTS</c> for columns, and re-running it
    /// is an error rather than a no-op. Reads <c>PRAGMA table_info</c> to decide.
    /// </summary>
    private static async Task AddColumnIfMissingAsync(
        SqliteConnection connection,
        string table,
        string column,
        string definition,
        CancellationToken ct)
    {
        await using (var probe = connection.CreateCommand())
        {
            // No parameter binding here: PRAGMA takes an identifier, not a value.
            // Both arguments are compile-time constants from the call sites above.
            probe.CommandText = $"PRAGMA table_info({table})";
            await using var reader = await probe.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
            {
                if (string.Equals(reader.GetString(1), column, StringComparison.OrdinalIgnoreCase))
                    return;
            }
        }

        await using var alter = connection.CreateCommand();
        alter.CommandText = $"ALTER TABLE {table} ADD COLUMN {column} {definition}";
        await alter.ExecuteNonQueryAsync(ct);
    }

    /// <summary>Enqueue every change to a searchable table. One trigger set per operation.</summary>
    private const string QueueTriggerSql = """
        CREATE TRIGGER IF NOT EXISTS trg_page_search_insert AFTER INSERT ON page BEGIN
          INSERT OR REPLACE INTO search_queue (kind, entity_id, op, queued_at)
          VALUES ('page', new.id, 'upsert', datetime('now'));
        END;
        CREATE TRIGGER IF NOT EXISTS trg_page_search_update AFTER UPDATE ON page BEGIN
          INSERT OR REPLACE INTO search_queue (kind, entity_id, op, queued_at)
          VALUES ('page', new.id, 'upsert', datetime('now'));
        END;
        CREATE TRIGGER IF NOT EXISTS trg_page_search_delete AFTER DELETE ON page BEGIN
          INSERT OR REPLACE INTO search_queue (kind, entity_id, op, queued_at)
          VALUES ('page', old.id, 'delete', datetime('now'));
        END;

        CREATE TRIGGER IF NOT EXISTS trg_diagram_search_insert AFTER INSERT ON diagram BEGIN
          INSERT OR REPLACE INTO search_queue (kind, entity_id, op, queued_at)
          VALUES ('diagram', new.id, 'upsert', datetime('now'));
        END;
        CREATE TRIGGER IF NOT EXISTS trg_diagram_search_update AFTER UPDATE ON diagram BEGIN
          INSERT OR REPLACE INTO search_queue (kind, entity_id, op, queued_at)
          VALUES ('diagram', new.id, 'upsert', datetime('now'));
        END;
        CREATE TRIGGER IF NOT EXISTS trg_diagram_search_delete AFTER DELETE ON diagram BEGIN
          INSERT OR REPLACE INTO search_queue (kind, entity_id, op, queued_at)
          VALUES ('diagram', old.id, 'delete', datetime('now'));
        END;

        CREATE TRIGGER IF NOT EXISTS trg_slide_deck_search_insert AFTER INSERT ON slide_deck BEGIN
          INSERT OR REPLACE INTO search_queue (kind, entity_id, op, queued_at)
          VALUES ('slides', new.id, 'upsert', datetime('now'));
        END;
        CREATE TRIGGER IF NOT EXISTS trg_slide_deck_search_update AFTER UPDATE ON slide_deck BEGIN
          INSERT OR REPLACE INTO search_queue (kind, entity_id, op, queued_at)
          VALUES ('slides', new.id, 'upsert', datetime('now'));
        END;
        CREATE TRIGGER IF NOT EXISTS trg_slide_deck_search_delete AFTER DELETE ON slide_deck BEGIN
          INSERT OR REPLACE INTO search_queue (kind, entity_id, op, queued_at)
          VALUES ('slides', old.id, 'delete', datetime('now'));
        END;

        CREATE TRIGGER IF NOT EXISTS trg_kanban_board_search_insert AFTER INSERT ON kanban_board BEGIN
          INSERT OR REPLACE INTO search_queue (kind, entity_id, op, queued_at)
          VALUES ('kanban', new.id, 'upsert', datetime('now'));
        END;
        CREATE TRIGGER IF NOT EXISTS trg_kanban_board_search_update AFTER UPDATE ON kanban_board BEGIN
          INSERT OR REPLACE INTO search_queue (kind, entity_id, op, queued_at)
          VALUES ('kanban', new.id, 'upsert', datetime('now'));
        END;
        CREATE TRIGGER IF NOT EXISTS trg_kanban_board_search_delete AFTER DELETE ON kanban_board BEGIN
          INSERT OR REPLACE INTO search_queue (kind, entity_id, op, queued_at)
          VALUES ('kanban', old.id, 'delete', datetime('now'));
        END;

        CREATE TRIGGER IF NOT EXISTS trg_project_plan_search_insert AFTER INSERT ON project_plan BEGIN
          INSERT OR REPLACE INTO search_queue (kind, entity_id, op, queued_at)
          VALUES ('project', new.id, 'upsert', datetime('now'));
        END;
        CREATE TRIGGER IF NOT EXISTS trg_project_plan_search_update AFTER UPDATE ON project_plan BEGIN
          INSERT OR REPLACE INTO search_queue (kind, entity_id, op, queued_at)
          VALUES ('project', new.id, 'upsert', datetime('now'));
        END;
        CREATE TRIGGER IF NOT EXISTS trg_project_plan_search_delete AFTER DELETE ON project_plan BEGIN
          INSERT OR REPLACE INTO search_queue (kind, entity_id, op, queued_at)
          VALUES ('project', old.id, 'delete', datetime('now'));
        END;

        CREATE TRIGGER IF NOT EXISTS trg_note_search_insert AFTER INSERT ON note BEGIN
          INSERT OR REPLACE INTO search_queue (kind, entity_id, op, queued_at)
          VALUES ('note', new.id, 'upsert', datetime('now'));
        END;
        CREATE TRIGGER IF NOT EXISTS trg_note_search_update AFTER UPDATE ON note BEGIN
          INSERT OR REPLACE INTO search_queue (kind, entity_id, op, queued_at)
          VALUES ('note', new.id, 'upsert', datetime('now'));
        END;
        CREATE TRIGGER IF NOT EXISTS trg_note_search_delete AFTER DELETE ON note BEGIN
          INSERT OR REPLACE INTO search_queue (kind, entity_id, op, queued_at)
          VALUES ('note', old.id, 'delete', datetime('now'));
        END;

        CREATE TRIGGER IF NOT EXISTS trg_attachment_search_insert AFTER INSERT ON attachment BEGIN
          INSERT OR REPLACE INTO search_queue (kind, entity_id, op, queued_at)
          VALUES ('attachment', new.id, 'upsert', datetime('now'));
        END;
        CREATE TRIGGER IF NOT EXISTS trg_attachment_search_update AFTER UPDATE ON attachment BEGIN
          INSERT OR REPLACE INTO search_queue (kind, entity_id, op, queued_at)
          VALUES ('attachment', new.id, 'upsert', datetime('now'));
        END;
        CREATE TRIGGER IF NOT EXISTS trg_attachment_search_delete AFTER DELETE ON attachment BEGIN
          INSERT OR REPLACE INTO search_queue (kind, entity_id, op, queued_at)
          VALUES ('attachment', old.id, 'delete', datetime('now'));
        END;

        CREATE TRIGGER IF NOT EXISTS trg_book_search_insert AFTER INSERT ON book BEGIN
          INSERT OR REPLACE INTO search_queue (kind, entity_id, op, queued_at)
          VALUES ('book', new.id, 'upsert', datetime('now'));
        END;
        CREATE TRIGGER IF NOT EXISTS trg_book_search_update AFTER UPDATE ON book BEGIN
          INSERT OR REPLACE INTO search_queue (kind, entity_id, op, queued_at)
          VALUES ('book', new.id, 'upsert', datetime('now'));
        END;
        CREATE TRIGGER IF NOT EXISTS trg_book_search_delete AFTER DELETE ON book BEGIN
          INSERT OR REPLACE INTO search_queue (kind, entity_id, op, queued_at)
          VALUES ('book', old.id, 'delete', datetime('now'));
        END;

        CREATE TRIGGER IF NOT EXISTS trg_shelf_search_insert AFTER INSERT ON shelf BEGIN
          INSERT OR REPLACE INTO search_queue (kind, entity_id, op, queued_at)
          VALUES ('shelf', new.id, 'upsert', datetime('now'));
        END;
        CREATE TRIGGER IF NOT EXISTS trg_shelf_search_update AFTER UPDATE ON shelf BEGIN
          INSERT OR REPLACE INTO search_queue (kind, entity_id, op, queued_at)
          VALUES ('shelf', new.id, 'upsert', datetime('now'));
        END;
        CREATE TRIGGER IF NOT EXISTS trg_shelf_search_delete AFTER DELETE ON shelf BEGIN
          INSERT OR REPLACE INTO search_queue (kind, entity_id, op, queued_at)
          VALUES ('shelf', old.id, 'delete', datetime('now'));
        END;

        CREATE TRIGGER IF NOT EXISTS trg_chapter_search_insert AFTER INSERT ON chapter BEGIN
          INSERT OR REPLACE INTO search_queue (kind, entity_id, op, queued_at)
          VALUES ('folder', new.id, 'upsert', datetime('now'));
        END;
        CREATE TRIGGER IF NOT EXISTS trg_chapter_search_update AFTER UPDATE ON chapter BEGIN
          INSERT OR REPLACE INTO search_queue (kind, entity_id, op, queued_at)
          VALUES ('folder', new.id, 'upsert', datetime('now'));
        END;
        CREATE TRIGGER IF NOT EXISTS trg_chapter_search_delete AFTER DELETE ON chapter BEGIN
          INSERT OR REPLACE INTO search_queue (kind, entity_id, op, queued_at)
          VALUES ('folder', old.id, 'delete', datetime('now'));
        END;
        """;

    /// <summary>
    /// Drop favorites whose target — or owner — is gone. Triggers rather than
    /// statements in each delete method, for the same reason the search queue
    /// uses them: every writer is covered, including the one delete path someone
    /// adds later without remembering this table exists. Deleting a book fires
    /// the child-table triggers too, because its pages, diagrams, decks, boards
    /// and attachments are deleted row by row in the same transaction.
    /// </summary>
    private const string FavoriteTriggerSql = """
        CREATE TRIGGER IF NOT EXISTS trg_book_favorite_delete AFTER DELETE ON book BEGIN
          DELETE FROM favorite WHERE kind = 'book' AND entity_id = old.id;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_page_favorite_delete AFTER DELETE ON page BEGIN
          DELETE FROM favorite WHERE kind = 'page' AND entity_id = old.id;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_diagram_favorite_delete AFTER DELETE ON diagram BEGIN
          DELETE FROM favorite WHERE kind = 'diagram' AND entity_id = old.id;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_slide_deck_favorite_delete AFTER DELETE ON slide_deck BEGIN
          DELETE FROM favorite WHERE kind = 'slides' AND entity_id = old.id;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_kanban_board_favorite_delete AFTER DELETE ON kanban_board BEGIN
          DELETE FROM favorite WHERE kind = 'kanban' AND entity_id = old.id;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_project_plan_favorite_delete AFTER DELETE ON project_plan BEGIN
          DELETE FROM favorite WHERE kind = 'project' AND entity_id = old.id;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_note_favorite_delete AFTER DELETE ON note BEGIN
          DELETE FROM favorite WHERE kind = 'note' AND entity_id = old.id;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_attachment_favorite_delete AFTER DELETE ON attachment BEGIN
          DELETE FROM favorite WHERE kind = 'attachment' AND entity_id = old.id;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_app_user_favorite_delete AFTER DELETE ON app_user BEGIN
          DELETE FROM favorite WHERE user_id = old.id;
        END;
        """;
}

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
              owner_id TEXT,
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

            -- Instance settings an admin can change at runtime from the Settings
            -- page — one row per key. The /api/v1 publish key lives here (its
            -- value is write-only, same rule as llm_provider.api_key); the
            -- BeeDocs:ApiKey configuration value is only a fallback.
            CREATE TABLE IF NOT EXISTS app_setting (
              key TEXT PRIMARY KEY NOT NULL,
              value TEXT NOT NULL,
              updated_at TEXT NOT NULL
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
            """;

        await cmd.ExecuteNonQueryAsync(ct);

        // CREATE TABLE IF NOT EXISTS does nothing to a table that already exists,
        // so columns added after a release reach existing databases only here.
        // Ordered before the indexes below, which reference them.
        await AddColumnIfMissingAsync(connection, "book", "owner_id", "TEXT", ct);
        // NULL is "at the library root", which is where every book in an existing
        // database already is — so the migration needs no backfill.
        await AddColumnIfMissingAsync(connection, "book", "shelf_id", "TEXT", ct);
        await AddColumnIfMissingAsync(connection, "page", "owner_id", "TEXT", ct);
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

        await using (var indexes = connection.CreateCommand())
        {
            indexes.CommandText = """
                -- History reads newest-first, and a page's "last changed by" is
                -- the row matching its current version.
                CREATE INDEX IF NOT EXISTS idx_page_revision_page_version ON page_revision(page_id, version DESC);
                CREATE INDEX IF NOT EXISTS idx_book_owner ON book(owner_id);
                CREATE INDEX IF NOT EXISTS idx_page_owner ON page(owner_id);
                CREATE INDEX IF NOT EXISTS idx_book_shelf ON book(shelf_id);
                CREATE INDEX IF NOT EXISTS idx_shelf_owner ON shelf(owner_id);
                """;
            await indexes.ExecuteNonQueryAsync(ct);
        }

        await using (var triggers = connection.CreateCommand())
        {
            triggers.CommandText = QueueTriggerSql;
            await triggers.ExecuteNonQueryAsync(ct);
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
}

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
            CREATE TABLE IF NOT EXISTS book (
              id TEXT PRIMARY KEY NOT NULL,
              title TEXT NOT NULL,
              description TEXT,
              slug TEXT NOT NULL UNIQUE,
              sort_order INTEGER NOT NULL DEFAULT 0,
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
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS page_revision (
              id TEXT PRIMARY KEY NOT NULL,
              page_id TEXT NOT NULL,
              version INTEGER NOT NULL,
              title TEXT NOT NULL,
              content TEXT NOT NULL,
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

            CREATE TABLE IF NOT EXISTS shape_collection (
              id TEXT PRIMARY KEY NOT NULL,
              book_id TEXT,
              name TEXT NOT NULL,
              description TEXT,
              source TEXT NOT NULL DEFAULT '',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_page_book ON page(book_id);
            CREATE INDEX IF NOT EXISTS idx_chapter_book ON chapter(book_id);
            CREATE INDEX IF NOT EXISTS idx_diagram_book ON diagram(book_id);
            CREATE INDEX IF NOT EXISTS idx_diagram_page ON diagram(page_id);
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

        await using (var triggers = connection.CreateCommand())
        {
            triggers.CommandText = QueueTriggerSql;
            await triggers.ExecuteNonQueryAsync(ct);
        }
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

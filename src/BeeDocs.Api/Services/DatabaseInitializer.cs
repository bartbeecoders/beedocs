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
            """;

        await cmd.ExecuteNonQueryAsync(ct);
    }
}

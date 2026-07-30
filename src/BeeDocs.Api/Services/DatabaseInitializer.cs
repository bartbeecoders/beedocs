using SurrealDb.Net;

namespace BeeDocs.Api.Services;

public static class DatabaseInitializer
{
    public static async Task EnsureSchemaAsync(ISurrealDbClient db, CancellationToken ct = default)
    {
        // Embedded engine errors on SELECT from undefined tables; define schema first.
        var statements = """
            DEFINE TABLE IF NOT EXISTS book SCHEMALESS;
            DEFINE TABLE IF NOT EXISTS chapter SCHEMALESS;
            DEFINE TABLE IF NOT EXISTS page SCHEMALESS;
            DEFINE TABLE IF NOT EXISTS page_revision SCHEMALESS;
            DEFINE TABLE IF NOT EXISTS diagram SCHEMALESS;
            DEFINE TABLE IF NOT EXISTS shape_collection SCHEMALESS;
            DEFINE INDEX IF NOT EXISTS book_slug ON book FIELDS slug UNIQUE;
            DEFINE INDEX IF NOT EXISTS page_book ON page FIELDS bookId;
            DEFINE INDEX IF NOT EXISTS diagram_book ON diagram FIELDS bookId;
            DEFINE INDEX IF NOT EXISTS diagram_page ON diagram FIELDS pageId;
            DEFINE INDEX IF NOT EXISTS shape_collection_book ON shape_collection FIELDS bookId;
            """;

        await db.RawQuery(statements, null, ct);
    }
}

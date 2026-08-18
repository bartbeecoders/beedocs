using Microsoft.Data.Sqlite;

namespace BeeDocs.Api.Services;

/// <summary>What a move accomplished. Errors keep enough text to act on.</summary>
public sealed record MoveReport(int Moved, int Skipped, IReadOnlyList<string> Errors);

/// <summary>
/// Relocates content bodies between storage backends: shelf assignment, book
/// moves between shelves, and repatriation before a shelf delete all run through
/// here. The unit of work is one row — load its body from wherever its own
/// <c>content_ref</c> says it lives, write it to the destination, then flip the
/// row in a single UPDATE — so an interrupted run leaves every row fully old or
/// fully new, and re-running skips the finished ones.
/// </summary>
public sealed class ShelfContentMover(
    SqliteConnectionFactory db,
    ContentStoreRouter router,
    ILogger<ShelfContentMover> logger)
{
    /// <summary>
    /// Give up on a run whose first rows all fail: the provider is down, and
    /// grinding through thousands of rows would only repeat the same error.
    /// </summary>
    private const int EarlyAbortThreshold = 5;

    /// <summary>
    /// Point the shelf at the target and move every body under it. The flag is
    /// set first, so saves arriving mid-move already write to the destination.
    /// </summary>
    public async Task<MoveReport> MoveShelfContentAsync(
        string shelfId, string? targetProviderId, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);

        await using (var flag = conn.CreateCommand())
        {
            flag.CommandText = """
                UPDATE shelf SET storage_provider_id = $provider, updated_at = $updated_at
                WHERE id = $id
                """;
            SqliteHelpers.Add(flag, "$id", shelfId);
            SqliteHelpers.Add(flag, "$provider", targetProviderId);
            SqliteHelpers.Add(flag, "$updated_at", SqliteHelpers.FormatTimestamp(DateTimeOffset.UtcNow));
            await flag.ExecuteNonQueryAsync(ct);
        }

        var bookIds = new List<string>();
        await using (var books = conn.CreateCommand())
        {
            books.CommandText = "SELECT id FROM book WHERE shelf_id = $id";
            SqliteHelpers.Add(books, "$id", shelfId);
            await using var reader = await books.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
                bookIds.Add(reader.GetString(0));
        }

        var moved = 0;
        var skipped = 0;
        var errors = new List<string>();
        foreach (var bookId in bookIds)
        {
            var report = await MoveBookContentAsync(bookId, targetProviderId, ct);
            moved += report.Moved;
            skipped += report.Skipped;
            errors.AddRange(report.Errors);
            if (moved == 0 && errors.Count >= EarlyAbortThreshold)
                break;
        }

        return new MoveReport(moved, skipped, errors);
    }

    public async Task<MoveReport> MoveBookContentAsync(
        string bookId, string? targetProviderId, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);

        var moved = 0;
        var skipped = 0;
        var errors = new List<string>();

        // (table, body column, rows-of-this-book predicate, key maker)
        var sources = new (string Table, string Column, string Where, Func<string, string> Key)[]
        {
            ("page", "content", "book_id = $book_id", ContentRef.PageKey),
            ("page_revision", "content",
                "page_id IN (SELECT id FROM page WHERE book_id = $book_id)", ContentRef.RevisionKey),
            ("diagram", "source", "book_id = $book_id", ContentRef.DiagramKey),
            ("slide_deck", "source", "book_id = $book_id", ContentRef.SlideDeckKey),
        };

        foreach (var (table, column, where, key) in sources)
        {
            var rows = new List<(string Id, string Inline, string? Ref)>();
            await using (var cmd = conn.CreateCommand())
            {
                // Identifiers are compile-time constants from the array above.
                cmd.CommandText = $"SELECT id, {column}, content_ref FROM {table} WHERE {where}";
                SqliteHelpers.Add(cmd, "$book_id", bookId);
                await using var reader = await cmd.ExecuteReaderAsync(ct);
                while (await reader.ReadAsync(ct))
                    rows.Add((reader.GetString(0), reader.GetString(1), SqliteHelpers.GetNullableString(reader, 2)));
            }

            foreach (var (id, inline, oldRef) in rows)
            {
                if (AtDestination(oldRef, targetProviderId))
                {
                    skipped++;
                    continue;
                }

                try
                {
                    await MoveRowAsync(conn, table, column, id, inline, oldRef, targetProviderId, key(id), ct);
                    moved++;
                }
                catch (Exception ex)
                {
                    var message = $"{table} {id}: {ex.GetBaseException().Message}";
                    logger.LogWarning(ex, "Moving {Table} row {Id} failed", table, id);
                    errors.Add(message);
                    if (moved == 0 && errors.Count >= EarlyAbortThreshold)
                        return new MoveReport(moved, skipped, errors);
                }
            }
        }

        return new MoveReport(moved, skipped, errors);
    }

    /// <summary>
    /// Relocate bodies for a set of pages (and their revisions and page-linked
    /// diagrams). Used when a folder moves between books that sit on different
    /// storage backends — the same per-row UPDATE as a whole-book move, scoped
    /// to what actually changed books.
    /// </summary>
    public async Task<MoveReport> MovePageSetContentAsync(
        IReadOnlyList<string> pageIds, string? targetProviderId, CancellationToken ct = default)
    {
        if (pageIds.Count == 0)
            return new MoveReport(0, 0, []);

        await using var conn = await db.OpenConnectionAsync(ct);

        var names = pageIds.Select((_, i) => $"$p{i}").ToArray();
        var inList = string.Join(", ", names);
        void BindIds(SqliteCommand cmd)
        {
            for (var i = 0; i < pageIds.Count; i++)
                SqliteHelpers.Add(cmd, names[i], pageIds[i]);
        }

        var moved = 0;
        var skipped = 0;
        var errors = new List<string>();

        var sources = new (string Table, string Column, string Where, Func<string, string> Key)[]
        {
            ("page", "content", $"id IN ({inList})", ContentRef.PageKey),
            ("page_revision", "content", $"page_id IN ({inList})", ContentRef.RevisionKey),
            ("diagram", "source", $"page_id IN ({inList})", ContentRef.DiagramKey),
        };

        foreach (var (table, column, where, key) in sources)
        {
            var rows = new List<(string Id, string Inline, string? Ref)>();
            await using (var cmd = conn.CreateCommand())
            {
                cmd.CommandText = $"SELECT id, {column}, content_ref FROM {table} WHERE {where}";
                BindIds(cmd);
                await using var reader = await cmd.ExecuteReaderAsync(ct);
                while (await reader.ReadAsync(ct))
                    rows.Add((reader.GetString(0), reader.GetString(1), SqliteHelpers.GetNullableString(reader, 2)));
            }

            foreach (var (id, inline, oldRef) in rows)
            {
                if (AtDestination(oldRef, targetProviderId))
                {
                    skipped++;
                    continue;
                }

                try
                {
                    await MoveRowAsync(conn, table, column, id, inline, oldRef, targetProviderId, key(id), ct);
                    moved++;
                }
                catch (Exception ex)
                {
                    var message = $"{table} {id}: {ex.GetBaseException().Message}";
                    logger.LogWarning(ex, "Moving {Table} row {Id} failed", table, id);
                    errors.Add(message);
                    if (moved == 0 && errors.Count >= EarlyAbortThreshold)
                        return new MoveReport(moved, skipped, errors);
                }
            }
        }

        return new MoveReport(moved, skipped, errors);
    }

    private static bool AtDestination(string? contentRef, string? targetProviderId) =>
        targetProviderId is null
            ? contentRef is null
            : contentRef is not null && contentRef.StartsWith(targetProviderId + ":", StringComparison.Ordinal);

    private async Task MoveRowAsync(
        SqliteConnection conn,
        string table,
        string column,
        string id,
        string inline,
        string? oldRef,
        string? targetProviderId,
        string suggestedKey,
        CancellationToken ct)
    {
        // The source of truth for where the body lives is the row's own ref —
        // never the shelf flag — which is also what makes cloud→cloud moves
        // work: the old provider comes out of the ref.
        var body = inline;
        if (ContentRef.TryParse(oldRef, out var oldProvider, out var oldKey))
        {
            var source = await router.ResolveAsync(oldProvider, ct);
            body = await source.GetAsync(oldKey, ct);
        }

        string newInline;
        string? newRef;
        long? newSize;
        if (targetProviderId is null)
        {
            newInline = body;
            newRef = null;
            newSize = null;
        }
        else
        {
            var destination = await router.ResolveAsync(targetProviderId, ct);
            var storedKey = await destination.PutAsync(suggestedKey, body, existingKey: null, ct);
            newInline = string.Empty;
            newRef = ContentRef.Format(targetProviderId, storedKey);
            newSize = System.Text.Encoding.UTF8.GetByteCount(body);
        }

        // One UPDATE per row — its own implicit transaction, so the row is
        // atomically fully old or fully new. Deliberately not touching
        // updated_at: relocation is not an edit, and updated_at stays the
        // authority the search reconcile compares against.
        await using (var update = conn.CreateCommand())
        {
            update.CommandText =
                $"UPDATE {table} SET {column} = $value, content_ref = $ref, content_size = $size WHERE id = $id";
            SqliteHelpers.Add(update, "$id", id);
            SqliteHelpers.Add(update, "$value", newInline);
            SqliteHelpers.Add(update, "$ref", newRef);
            SqliteHelpers.Add(update, "$size", newSize);
            await update.ExecuteNonQueryAsync(ct);
        }

        // Only after the row committed may the old object go — and only
        // best-effort: an orphan is recoverable noise, a dangling ref is not.
        if (oldRef is not null && oldRef != newRef
            && ContentRef.TryParse(oldRef, out var obsoleteProvider, out var obsoleteKey))
        {
            try
            {
                var source = await router.ResolveAsync(obsoleteProvider, ct);
                await source.DeleteAsync(obsoleteKey, ct);
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Deleting moved object {Ref} failed; object orphaned", oldRef);
            }
        }
    }
}

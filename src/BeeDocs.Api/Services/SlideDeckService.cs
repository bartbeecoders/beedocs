using System.Text.Json;
using BeeDocs.Api.Models;
using Microsoft.Data.Sqlite;

namespace BeeDocs.Api.Services;

public interface ISlideDeckService
{
    Task<IReadOnlyList<SlideDeckSummaryDto>> ListByBookAsync(string bookId, CancellationToken ct = default);
    Task<SlideDeckDto?> GetAsync(string id, CancellationToken ct = default);
    Task<SlideDeckDto> CreateAsync(string bookId, CreateSlideDeckRequest request, CancellationToken ct = default);
    Task<SlideDeckDto?> UpdateAsync(string id, UpdateSlideDeckRequest request, CancellationToken ct = default);
    Task<bool> DeleteAsync(string id, CancellationToken ct = default);

    /// <summary>
    /// Fill <c>slide_count</c> on rows written before the column existed. Runs
    /// once at startup; every save maintains the column afterwards, so list
    /// projections never need the (possibly offloaded) source just for a badge.
    /// </summary>
    Task BackfillSlideCountsAsync(CancellationToken ct = default);
}

public sealed class SlideDeckService(SqliteConnectionFactory db, ContentResolver resolver) : ISlideDeckService
{
    /// <summary>One blank 16:9 slide. The web editor owns the richer starter decks.</summary>
    public static string DefaultSource { get; } =
        """{"version":1,"size":{"w":1280,"h":720},"theme":{"background":"#ffffff","color":"#1f2430","accent":"#f59e0b","fontFamily":"'Segoe UI', system-ui, sans-serif"},"slides":[{"id":"slide-1","elements":[]}]}""";

    public async Task<IReadOnlyList<SlideDeckSummaryDto>> ListByBookAsync(string bookId, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        // slide_count is NULL only on pre-column rows the backfill has not seen,
        // where the source is guaranteed inline — so the fallback stays local.
        cmd.CommandText = """
            SELECT id, book_id, title, source, updated_at, slide_count
            FROM slide_deck WHERE book_id = $book_id
            ORDER BY updated_at DESC, title COLLATE NOCASE
            """;
        SqliteHelpers.Add(cmd, "$book_id", bookId);
        var list = new List<SlideDeckSummaryDto>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            list.Add(new SlideDeckSummaryDto(
                Id: reader.GetString(0),
                BookId: reader.GetString(1),
                Title: reader.GetString(2),
                SlideCount: reader.IsDBNull(5)
                    ? CountSlides(SqliteHelpers.GetNullableString(reader, 3))
                    : (int)reader.GetInt64(5),
                UpdatedAt: SqliteHelpers.ReadTimestamp(reader, 4)));
        }
        return list;
    }

    public async Task<SlideDeckDto?> GetAsync(string id, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var row = await SelectAsync(conn, id, ct);
        if (row is null) return null;
        row.Source = await resolver.LoadAsync(row.Source, row.ContentRef, ct);
        return ToDto(row);
    }

    public async Task<SlideDeckDto> CreateAsync(string bookId, CreateSlideDeckRequest request, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using (var check = conn.CreateCommand())
        {
            check.CommandText = "SELECT 1 FROM book WHERE id = $id LIMIT 1";
            SqliteHelpers.Add(check, "$id", bookId);
            var found = await check.ExecuteScalarAsync(ct);
            if (found is null)
                throw new KeyNotFoundException($"Book '{bookId}' not found.");
        }

        var now = DateTimeOffset.UtcNow;
        var body = string.IsNullOrWhiteSpace(request.Source) ? DefaultSource : request.Source;
        var deck = new SlideDeck
        {
            Id = SqliteHelpers.NewId(),
            BookId = bookId,
            Title = request.Title.Trim(),
            SlideCount = CountSlides(body),
            CreatedAt = now,
            UpdatedAt = now,
        };

        var target = await ContentResolver.ProviderIdForBookAsync(conn, bookId, ct);
        var cell = await resolver.SaveAsync(body, target, ContentRef.SlideDeckKey(deck.Id), null, ct);
        deck.Source = cell.InlineValue;
        deck.ContentRef = cell.ContentRef;
        deck.ContentSize = cell.ContentSize;

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO slide_deck (id, book_id, title, source, content_ref, content_size, slide_count,
              created_at, updated_at)
            VALUES ($id, $book_id, $title, $source, $content_ref, $content_size, $slide_count,
              $created_at, $updated_at)
            """;
        SqliteHelpers.Add(cmd, "$id", deck.Id);
        SqliteHelpers.Add(cmd, "$book_id", deck.BookId);
        SqliteHelpers.Add(cmd, "$title", deck.Title);
        SqliteHelpers.Add(cmd, "$source", deck.Source);
        SqliteHelpers.Add(cmd, "$content_ref", deck.ContentRef);
        SqliteHelpers.Add(cmd, "$content_size", deck.ContentSize);
        SqliteHelpers.Add(cmd, "$slide_count", deck.SlideCount);
        SqliteHelpers.Add(cmd, "$created_at", SqliteHelpers.FormatTimestamp(deck.CreatedAt));
        SqliteHelpers.Add(cmd, "$updated_at", SqliteHelpers.FormatTimestamp(deck.UpdatedAt));
        await cmd.ExecuteNonQueryAsync(ct);

        deck.Source = body;
        return ToDto(deck);
    }

    public async Task<SlideDeckDto?> UpdateAsync(string id, UpdateSlideDeckRequest request, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var existing = await SelectAsync(conn, id, ct);
        if (existing is null) return null;

        existing.Title = request.Title.Trim();
        existing.UpdatedAt = DateTimeOffset.UtcNow;

        // Provider I/O before the write, same discipline as pages: a rename of an
        // offloaded deck fetches the body so the row stays whole.
        var target = await ContentResolver.ProviderIdForBookAsync(conn, existing.BookId, ct);
        var oldRef = existing.ContentRef;
        var body = request.Source ?? await resolver.LoadAsync(existing.Source, existing.ContentRef, ct);
        existing.SlideCount = CountSlides(body);
        var cell = await resolver.SaveAsync(body, target, ContentRef.SlideDeckKey(existing.Id), oldRef, ct);
        existing.Source = cell.InlineValue;
        existing.ContentRef = cell.ContentRef;
        existing.ContentSize = cell.ContentSize;

        await using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = """
                UPDATE slide_deck SET title = $title, source = $source, content_ref = $content_ref,
                  content_size = $content_size, slide_count = $slide_count, updated_at = $updated_at
                WHERE id = $id
                """;
            SqliteHelpers.Add(cmd, "$id", existing.Id);
            SqliteHelpers.Add(cmd, "$title", existing.Title);
            SqliteHelpers.Add(cmd, "$source", existing.Source);
            SqliteHelpers.Add(cmd, "$content_ref", existing.ContentRef);
            SqliteHelpers.Add(cmd, "$content_size", existing.ContentSize);
            SqliteHelpers.Add(cmd, "$slide_count", existing.SlideCount);
            SqliteHelpers.Add(cmd, "$updated_at", SqliteHelpers.FormatTimestamp(existing.UpdatedAt));
            await cmd.ExecuteNonQueryAsync(ct);
        }

        await resolver.CleanupReplacedAsync(oldRef, cell.ContentRef, ct);
        existing.Source = body;
        return ToDto(existing);
    }

    public async Task<bool> DeleteAsync(string id, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var existing = await SelectAsync(conn, id, ct);
        if (existing is null) return false;

        await using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = "DELETE FROM slide_deck WHERE id = $id";
            SqliteHelpers.Add(cmd, "$id", id);
            await cmd.ExecuteNonQueryAsync(ct);
        }

        await resolver.DeleteAsync(existing.ContentRef, ct);
        return true;
    }

    public async Task BackfillSlideCountsAsync(CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var pending = new List<(string Id, string? Source)>();
        await using (var cmd = conn.CreateCommand())
        {
            // Pre-column rows are necessarily inline — offloading and the column
            // arrived together — so the source read here never leaves SQLite.
            cmd.CommandText = "SELECT id, source FROM slide_deck WHERE slide_count IS NULL";
            await using var reader = await cmd.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
                pending.Add((reader.GetString(0), SqliteHelpers.GetNullableString(reader, 1)));
        }

        foreach (var (id, source) in pending)
        {
            await using var update = conn.CreateCommand();
            // Deliberately not touching updated_at: counting slides is not an edit.
            update.CommandText = "UPDATE slide_deck SET slide_count = $count WHERE id = $id";
            SqliteHelpers.Add(update, "$id", id);
            SqliteHelpers.Add(update, "$count", CountSlides(source));
            await update.ExecuteNonQueryAsync(ct);
        }
    }

    /// <summary>Slides in a stored document. A deck that fails to parse counts as none.</summary>
    internal static int CountSlides(string? source)
    {
        if (string.IsNullOrWhiteSpace(source)) return 0;
        try
        {
            using var doc = JsonDocument.Parse(source);
            if (doc.RootElement.ValueKind == JsonValueKind.Object
                && doc.RootElement.TryGetProperty("slides", out var slides)
                && slides.ValueKind == JsonValueKind.Array)
            {
                return slides.GetArrayLength();
            }
        }
        catch (JsonException)
        {
        }
        return 0;
    }

    private static async Task<SlideDeck?> SelectAsync(SqliteConnection conn, string id, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT id, book_id, title, source, created_at, updated_at, content_ref, content_size, slide_count
            FROM slide_deck WHERE id = $id LIMIT 1
            """;
        SqliteHelpers.Add(cmd, "$id", id);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) return null;
        return new SlideDeck
        {
            Id = reader.GetString(0),
            BookId = reader.GetString(1),
            Title = reader.GetString(2),
            Source = reader.GetString(3),
            CreatedAt = SqliteHelpers.ReadTimestamp(reader, 4),
            UpdatedAt = SqliteHelpers.ReadTimestamp(reader, 5),
            ContentRef = SqliteHelpers.GetNullableString(reader, 6),
            ContentSize = reader.IsDBNull(7) ? null : reader.GetInt64(7),
            SlideCount = reader.IsDBNull(8) ? null : (int)reader.GetInt64(8),
        };
    }

    private static SlideDeckDto ToDto(SlideDeck d) => new(
        Id: d.Id,
        BookId: d.BookId,
        Title: d.Title,
        Source: d.Source,
        CreatedAt: d.CreatedAt,
        UpdatedAt: d.UpdatedAt);
}

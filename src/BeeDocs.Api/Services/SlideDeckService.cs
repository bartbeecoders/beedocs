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
}

public sealed class SlideDeckService(SqliteConnectionFactory db) : ISlideDeckService
{
    /// <summary>One blank 16:9 slide. The web editor owns the richer starter decks.</summary>
    public static string DefaultSource { get; } =
        """{"version":1,"size":{"w":1280,"h":720},"theme":{"background":"#ffffff","color":"#1f2430","accent":"#f59e0b","fontFamily":"'Segoe UI', system-ui, sans-serif"},"slides":[{"id":"slide-1","elements":[]}]}""";

    public async Task<IReadOnlyList<SlideDeckSummaryDto>> ListByBookAsync(string bookId, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT id, book_id, title, source, updated_at
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
                SlideCount: CountSlides(SqliteHelpers.GetNullableString(reader, 3)),
                UpdatedAt: SqliteHelpers.ReadTimestamp(reader, 4)));
        }
        return list;
    }

    public async Task<SlideDeckDto?> GetAsync(string id, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var row = await SelectAsync(conn, id, ct);
        return row is null ? null : ToDto(row);
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
        var deck = new SlideDeck
        {
            Id = SqliteHelpers.NewId(),
            BookId = bookId,
            Title = request.Title.Trim(),
            Source = string.IsNullOrWhiteSpace(request.Source) ? DefaultSource : request.Source,
            CreatedAt = now,
            UpdatedAt = now,
        };

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO slide_deck (id, book_id, title, source, created_at, updated_at)
            VALUES ($id, $book_id, $title, $source, $created_at, $updated_at)
            """;
        SqliteHelpers.Add(cmd, "$id", deck.Id);
        SqliteHelpers.Add(cmd, "$book_id", deck.BookId);
        SqliteHelpers.Add(cmd, "$title", deck.Title);
        SqliteHelpers.Add(cmd, "$source", deck.Source);
        SqliteHelpers.Add(cmd, "$created_at", SqliteHelpers.FormatTimestamp(deck.CreatedAt));
        SqliteHelpers.Add(cmd, "$updated_at", SqliteHelpers.FormatTimestamp(deck.UpdatedAt));
        await cmd.ExecuteNonQueryAsync(ct);
        return ToDto(deck);
    }

    public async Task<SlideDeckDto?> UpdateAsync(string id, UpdateSlideDeckRequest request, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var existing = await SelectAsync(conn, id, ct);
        if (existing is null) return null;

        existing.Title = request.Title.Trim();
        if (request.Source is not null)
            existing.Source = request.Source;
        existing.UpdatedAt = DateTimeOffset.UtcNow;

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            UPDATE slide_deck SET title = $title, source = $source, updated_at = $updated_at
            WHERE id = $id
            """;
        SqliteHelpers.Add(cmd, "$id", existing.Id);
        SqliteHelpers.Add(cmd, "$title", existing.Title);
        SqliteHelpers.Add(cmd, "$source", existing.Source);
        SqliteHelpers.Add(cmd, "$updated_at", SqliteHelpers.FormatTimestamp(existing.UpdatedAt));
        await cmd.ExecuteNonQueryAsync(ct);
        return ToDto(existing);
    }

    public async Task<bool> DeleteAsync(string id, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var existing = await SelectAsync(conn, id, ct);
        if (existing is null) return false;

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "DELETE FROM slide_deck WHERE id = $id";
        SqliteHelpers.Add(cmd, "$id", id);
        await cmd.ExecuteNonQueryAsync(ct);
        return true;
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
            SELECT id, book_id, title, source, created_at, updated_at
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

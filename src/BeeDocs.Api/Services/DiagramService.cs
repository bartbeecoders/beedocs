using BeeDocs.Api.Models;
using Microsoft.Data.Sqlite;

namespace BeeDocs.Api.Services;

public interface IDiagramService
{
    Task<IReadOnlyList<DiagramSummaryDto>> ListByBookAsync(string bookId, CancellationToken ct = default);
    Task<IReadOnlyList<DiagramSummaryDto>> ListByPageAsync(string pageId, CancellationToken ct = default);
    Task<DiagramDto?> GetAsync(string id, CancellationToken ct = default);
    Task<DiagramDto> CreateAsync(string bookId, CreateDiagramRequest request, CancellationToken ct = default);
    Task<DiagramDto?> UpdateAsync(string id, UpdateDiagramRequest request, CancellationToken ct = default);
    Task<bool> DeleteAsync(string id, CancellationToken ct = default);
}

public sealed class DiagramService(SqliteConnectionFactory db) : IDiagramService
{
    public static string DefaultBeeDiagramSource { get; } =
        """{"version":1,"nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}""";

    public async Task<IReadOnlyList<DiagramSummaryDto>> ListByBookAsync(string bookId, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT id, book_id, page_id, title, kind, updated_at
            FROM diagram WHERE book_id = $book_id
            ORDER BY updated_at DESC, title COLLATE NOCASE
            """;
        SqliteHelpers.Add(cmd, "$book_id", bookId);
        var list = new List<DiagramSummaryDto>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
            list.Add(ReadSummary(reader));
        return list;
    }

    public async Task<IReadOnlyList<DiagramSummaryDto>> ListByPageAsync(string pageId, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT id, book_id, page_id, title, kind, updated_at
            FROM diagram WHERE page_id = $page_id
            ORDER BY updated_at DESC
            """;
        SqliteHelpers.Add(cmd, "$page_id", pageId);
        var list = new List<DiagramSummaryDto>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
            list.Add(ReadSummary(reader));
        return list;
    }

    public async Task<DiagramDto?> GetAsync(string id, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var row = await SelectAsync(conn, id, ct);
        return row is null ? null : ToDto(row);
    }

    public async Task<DiagramDto> CreateAsync(string bookId, CreateDiagramRequest request, CancellationToken ct = default)
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

        var kind = NormalizeKind(request.Kind);
        var now = DateTimeOffset.UtcNow;
        var source = string.IsNullOrWhiteSpace(request.Source)
            ? (kind == "beediagram" ? DefaultBeeDiagramSource : string.Empty)
            : request.Source;

        var diagram = new Diagram
        {
            Id = SqliteHelpers.NewId(),
            BookId = bookId,
            PageId = string.IsNullOrWhiteSpace(request.PageId) ? null : request.PageId.Trim(),
            Title = request.Title.Trim(),
            Kind = kind,
            Source = source,
            CreatedAt = now,
            UpdatedAt = now,
        };

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO diagram (id, book_id, page_id, title, kind, source, created_at, updated_at)
            VALUES ($id, $book_id, $page_id, $title, $kind, $source, $created_at, $updated_at)
            """;
        SqliteHelpers.Add(cmd, "$id", diagram.Id);
        SqliteHelpers.Add(cmd, "$book_id", diagram.BookId);
        SqliteHelpers.Add(cmd, "$page_id", diagram.PageId);
        SqliteHelpers.Add(cmd, "$title", diagram.Title);
        SqliteHelpers.Add(cmd, "$kind", diagram.Kind);
        SqliteHelpers.Add(cmd, "$source", diagram.Source);
        SqliteHelpers.Add(cmd, "$created_at", SqliteHelpers.FormatTimestamp(diagram.CreatedAt));
        SqliteHelpers.Add(cmd, "$updated_at", SqliteHelpers.FormatTimestamp(diagram.UpdatedAt));
        await cmd.ExecuteNonQueryAsync(ct);
        return ToDto(diagram);
    }

    public async Task<DiagramDto?> UpdateAsync(string id, UpdateDiagramRequest request, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var existing = await SelectAsync(conn, id, ct);
        if (existing is null) return null;

        existing.Title = request.Title.Trim();
        if (!string.IsNullOrWhiteSpace(request.Kind))
            existing.Kind = NormalizeKind(request.Kind);
        if (request.Source is not null)
            existing.Source = request.Source;
        if (request.PageId is not null)
            existing.PageId = string.IsNullOrWhiteSpace(request.PageId) ? null : request.PageId.Trim();
        existing.UpdatedAt = DateTimeOffset.UtcNow;

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            UPDATE diagram SET title = $title, kind = $kind, source = $source, page_id = $page_id,
              updated_at = $updated_at
            WHERE id = $id
            """;
        SqliteHelpers.Add(cmd, "$id", existing.Id);
        SqliteHelpers.Add(cmd, "$title", existing.Title);
        SqliteHelpers.Add(cmd, "$kind", existing.Kind);
        SqliteHelpers.Add(cmd, "$source", existing.Source);
        SqliteHelpers.Add(cmd, "$page_id", existing.PageId);
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
        cmd.CommandText = "DELETE FROM diagram WHERE id = $id";
        SqliteHelpers.Add(cmd, "$id", id);
        await cmd.ExecuteNonQueryAsync(ct);
        return true;
    }

    private static async Task<Diagram?> SelectAsync(SqliteConnection conn, string id, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT id, book_id, page_id, title, kind, source, created_at, updated_at
            FROM diagram WHERE id = $id LIMIT 1
            """;
        SqliteHelpers.Add(cmd, "$id", id);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) return null;
        return new Diagram
        {
            Id = reader.GetString(0),
            BookId = reader.GetString(1),
            PageId = SqliteHelpers.GetNullableString(reader, 2),
            Title = reader.GetString(3),
            Kind = reader.GetString(4),
            Source = reader.GetString(5),
            CreatedAt = SqliteHelpers.ReadTimestamp(reader, 6),
            UpdatedAt = SqliteHelpers.ReadTimestamp(reader, 7),
        };
    }

    private static string NormalizeKind(string? kind)
    {
        var k = (kind ?? "beediagram").Trim().ToLowerInvariant();
        return k switch
        {
            "beediagram" or "mermaid" or "plantuml" or "c4" => k,
            _ => "beediagram"
        };
    }

    private static DateTimeOffset Coalesce(DateTimeOffset value) =>
        value == default ? DateTimeOffset.UtcNow : value;

    private static DiagramSummaryDto ReadSummary(SqliteDataReader reader) => new(
        Id: reader.GetString(0),
        BookId: reader.GetString(1),
        PageId: SqliteHelpers.GetNullableString(reader, 2),
        Title: reader.GetString(3),
        Kind: reader.GetString(4),
        UpdatedAt: Coalesce(SqliteHelpers.ReadTimestamp(reader, 5)));

    private static DiagramDto ToDto(Diagram d) => new(
        Id: d.Id,
        BookId: d.BookId,
        PageId: d.PageId,
        Title: d.Title,
        Kind: d.Kind,
        Source: d.Source,
        CreatedAt: Coalesce(d.CreatedAt),
        UpdatedAt: Coalesce(d.UpdatedAt));
}

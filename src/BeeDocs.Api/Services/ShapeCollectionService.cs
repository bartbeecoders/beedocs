using BeeDocs.Api.Models;
using Microsoft.Data.Sqlite;

namespace BeeDocs.Api.Services;

public interface IShapeCollectionService
{
    /// <summary>Collections saved on a specific book (not app-wide).</summary>
    Task<IReadOnlyList<ShapeCollectionDto>> ListByBookAsync(string bookId, CancellationToken ct = default);

    /// <summary>Collections in the app-wide library (available in every book).</summary>
    Task<IReadOnlyList<ShapeCollectionDto>> ListAppAsync(CancellationToken ct = default);

    Task<ShapeCollectionDto?> GetAsync(string id, CancellationToken ct = default);

    /// <summary>
    /// Create a collection. Pass a book id for book scope, or null for app-wide.
    /// </summary>
    Task<ShapeCollectionDto> CreateAsync(
        string? bookId,
        CreateShapeCollectionRequest request,
        CancellationToken ct = default);

    Task<ShapeCollectionDto?> UpdateAsync(string id, UpdateShapeCollectionRequest request, CancellationToken ct = default);
    Task<bool> DeleteAsync(string id, CancellationToken ct = default);

    /// <summary>Delete only book-scoped collections for this book (leaves app-wide alone).</summary>
    Task DeleteByBookAsync(string bookId, CancellationToken ct = default);
}

public sealed class ShapeCollectionService(SqliteConnectionFactory db) : IShapeCollectionService
{
    public async Task<IReadOnlyList<ShapeCollectionDto>> ListByBookAsync(string bookId, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT id, book_id, name, description, source, created_at, updated_at
            FROM shape_collection
            WHERE book_id IS NOT NULL AND book_id != '' AND book_id = $book_id
            ORDER BY name COLLATE NOCASE, updated_at DESC
            """;
        SqliteHelpers.Add(cmd, "$book_id", bookId);
        return await ReadAllAsync(cmd, ct);
    }

    public async Task<IReadOnlyList<ShapeCollectionDto>> ListAppAsync(CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT id, book_id, name, description, source, created_at, updated_at
            FROM shape_collection
            WHERE book_id IS NULL OR book_id = ''
            ORDER BY name COLLATE NOCASE, updated_at DESC
            """;
        return await ReadAllAsync(cmd, ct);
    }

    public async Task<ShapeCollectionDto?> GetAsync(string id, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var row = await SelectAsync(conn, id, ct);
        return row is null ? null : ToDto(row);
    }

    public async Task<ShapeCollectionDto> CreateAsync(
        string? bookId,
        CreateShapeCollectionRequest request,
        CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        string? resolvedBookId = null;
        if (!string.IsNullOrWhiteSpace(bookId))
        {
            await using var check = conn.CreateCommand();
            check.CommandText = "SELECT id FROM book WHERE id = $id LIMIT 1";
            SqliteHelpers.Add(check, "$id", bookId);
            var found = await check.ExecuteScalarAsync(ct) as string;
            if (found is null)
                throw new KeyNotFoundException($"Book '{bookId}' not found.");
            resolvedBookId = found;
        }

        var now = DateTimeOffset.UtcNow;
        var row = new ShapeCollection
        {
            Id = SqliteHelpers.NewId(),
            BookId = resolvedBookId,
            Name = request.Name.Trim(),
            Description = string.IsNullOrWhiteSpace(request.Description) ? null : request.Description.Trim(),
            Source = request.Source,
            CreatedAt = now,
            UpdatedAt = now,
        };

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO shape_collection (id, book_id, name, description, source, created_at, updated_at)
            VALUES ($id, $book_id, $name, $description, $source, $created_at, $updated_at)
            """;
        SqliteHelpers.Add(cmd, "$id", row.Id);
        SqliteHelpers.Add(cmd, "$book_id", row.BookId);
        SqliteHelpers.Add(cmd, "$name", row.Name);
        SqliteHelpers.Add(cmd, "$description", row.Description);
        SqliteHelpers.Add(cmd, "$source", row.Source);
        SqliteHelpers.Add(cmd, "$created_at", SqliteHelpers.FormatTimestamp(row.CreatedAt));
        SqliteHelpers.Add(cmd, "$updated_at", SqliteHelpers.FormatTimestamp(row.UpdatedAt));
        await cmd.ExecuteNonQueryAsync(ct);
        return ToDto(row);
    }

    public async Task<ShapeCollectionDto?> UpdateAsync(
        string id,
        UpdateShapeCollectionRequest request,
        CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var existing = await SelectAsync(conn, id, ct);
        if (existing is null) return null;

        existing.Name = request.Name.Trim();
        existing.Description = string.IsNullOrWhiteSpace(request.Description) ? null : request.Description.Trim();
        if (request.Source is not null)
            existing.Source = request.Source;
        existing.UpdatedAt = DateTimeOffset.UtcNow;

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            UPDATE shape_collection SET name = $name, description = $description, source = $source,
              updated_at = $updated_at
            WHERE id = $id
            """;
        SqliteHelpers.Add(cmd, "$id", existing.Id);
        SqliteHelpers.Add(cmd, "$name", existing.Name);
        SqliteHelpers.Add(cmd, "$description", existing.Description);
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
        cmd.CommandText = "DELETE FROM shape_collection WHERE id = $id";
        SqliteHelpers.Add(cmd, "$id", id);
        await cmd.ExecuteNonQueryAsync(ct);
        return true;
    }

    public async Task DeleteByBookAsync(string bookId, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            DELETE FROM shape_collection
            WHERE book_id IS NOT NULL AND book_id != '' AND book_id = $book_id
            """;
        SqliteHelpers.Add(cmd, "$book_id", bookId);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    private static async Task<ShapeCollection?> SelectAsync(SqliteConnection conn, string id, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT id, book_id, name, description, source, created_at, updated_at
            FROM shape_collection WHERE id = $id LIMIT 1
            """;
        SqliteHelpers.Add(cmd, "$id", id);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) return null;
        return ReadEntity(reader);
    }

    private static async Task<IReadOnlyList<ShapeCollectionDto>> ReadAllAsync(SqliteCommand cmd, CancellationToken ct)
    {
        var list = new List<ShapeCollectionDto>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
            list.Add(ToDto(ReadEntity(reader)));
        return list;
    }

    private static ShapeCollection ReadEntity(SqliteDataReader reader) => new()
    {
        Id = reader.GetString(0),
        BookId = SqliteHelpers.GetNullableString(reader, 1),
        Name = reader.GetString(2),
        Description = SqliteHelpers.GetNullableString(reader, 3),
        Source = reader.GetString(4),
        CreatedAt = SqliteHelpers.ReadTimestamp(reader, 5),
        UpdatedAt = SqliteHelpers.ReadTimestamp(reader, 6),
    };

    private static DateTimeOffset Coalesce(DateTimeOffset value) =>
        value == default ? DateTimeOffset.UtcNow : value;

    private static ShapeCollectionDto ToDto(ShapeCollection c)
    {
        var bookId = string.IsNullOrWhiteSpace(c.BookId) ? null : c.BookId;
        return new(
            Id: c.Id,
            BookId: bookId,
            Name: c.Name,
            Description: c.Description,
            Source: c.Source ?? string.Empty,
            CreatedAt: Coalesce(c.CreatedAt),
            UpdatedAt: Coalesce(c.UpdatedAt));
    }
}

using BeeDocs.Api.Models;
using SurrealDb.Net;
using SurrealDb.Net.Models;

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

public sealed class ShapeCollectionService(ISurrealDbClient db) : IShapeCollectionService
{
    private const string Table = "shape_collection";
    private const string Books = "book";

    public async Task<IReadOnlyList<ShapeCollectionDto>> ListByBookAsync(string bookId, CancellationToken ct = default)
    {
        var rows = await db.Select<ShapeCollection>(Table, ct);
        var want = NormalizeId(bookId);
        return rows
            .Where(c => !IsAppLevel(c) && NormalizeId(c.BookId) == want)
            .OrderBy(c => c.Name, StringComparer.OrdinalIgnoreCase)
            .ThenByDescending(c => c.UpdatedAt)
            .Select(ToDto)
            .ToList();
    }

    public async Task<IReadOnlyList<ShapeCollectionDto>> ListAppAsync(CancellationToken ct = default)
    {
        var rows = await db.Select<ShapeCollection>(Table, ct);
        return rows
            .Where(IsAppLevel)
            .OrderBy(c => c.Name, StringComparer.OrdinalIgnoreCase)
            .ThenByDescending(c => c.UpdatedAt)
            .Select(ToDto)
            .ToList();
    }

    public async Task<ShapeCollectionDto?> GetAsync(string id, CancellationToken ct = default)
    {
        var row = await db.Select<ShapeCollection>(ToThing(Table, id), ct);
        return row is null ? null : ToDto(row);
    }

    public async Task<ShapeCollectionDto> CreateAsync(
        string? bookId,
        CreateShapeCollectionRequest request,
        CancellationToken ct = default)
    {
        string? resolvedBookId = null;
        if (!string.IsNullOrWhiteSpace(bookId))
        {
            var book = await db.Select<Book>(ToThing(Books, bookId), ct)
                ?? throw new KeyNotFoundException($"Book '{bookId}' not found.");
            resolvedBookId = string.IsNullOrEmpty(IdOf(book)) ? NormalizeId(bookId) : IdOf(book);
        }

        var now = DateTimeOffset.UtcNow;
        var row = new ShapeCollection
        {
            BookId = resolvedBookId,
            Name = request.Name.Trim(),
            Description = string.IsNullOrWhiteSpace(request.Description) ? null : request.Description.Trim(),
            Source = request.Source,
            CreatedAt = now,
            UpdatedAt = now,
        };

        var created = await db.Create(Table, row, ct)
            ?? throw new InvalidOperationException("Failed to create shape collection.");
        return ToDto(created);
    }

    public async Task<ShapeCollectionDto?> UpdateAsync(
        string id,
        UpdateShapeCollectionRequest request,
        CancellationToken ct = default)
    {
        var existing = await db.Select<ShapeCollection>(ToThing(Table, id), ct);
        if (existing is null) return null;

        existing.Name = request.Name.Trim();
        existing.Description = string.IsNullOrWhiteSpace(request.Description) ? null : request.Description.Trim();
        if (request.Source is not null)
            existing.Source = request.Source;
        existing.UpdatedAt = DateTimeOffset.UtcNow;

        var updated = await db.Upsert<ShapeCollection, ShapeCollection>(ToThing(Table, id), existing, ct);
        return updated is null ? null : ToDto(updated);
    }

    public async Task<bool> DeleteAsync(string id, CancellationToken ct = default)
    {
        var existing = await db.Select<ShapeCollection>(ToThing(Table, id), ct);
        if (existing is null) return false;
        await db.Delete(ToThing(Table, id), ct);
        return true;
    }

    public async Task DeleteByBookAsync(string bookId, CancellationToken ct = default)
    {
        var want = NormalizeId(bookId);
        var rows = await db.Select<ShapeCollection>(Table, ct);
        foreach (var row in rows.Where(c => !IsAppLevel(c) && NormalizeId(c.BookId) == want))
        {
            if (row.Id is not null)
                await db.Delete(row.Id, ct);
        }
    }

    private static bool IsAppLevel(ShapeCollection c) =>
        string.IsNullOrWhiteSpace(c.BookId);

    private static string NormalizeId(string? id)
    {
        if (string.IsNullOrWhiteSpace(id)) return string.Empty;
        var s = id.Trim();
        var idx = s.IndexOf(':');
        return idx >= 0 ? s[(idx + 1)..] : s;
    }

    private static string IdOf(Record? record)
    {
        if (record?.Id is null) return string.Empty;
        try
        {
            return record.Id.DeserializeId<string>();
        }
        catch
        {
            if (record.Id is RecordIdOfString typed)
                return typed.Id;
            return NormalizeId(record.Id.ToString());
        }
    }

    private static RecordId ToThing(string table, string id) =>
        RecordId.From(table, NormalizeId(id));

    private static DateTimeOffset Coalesce(DateTimeOffset value) =>
        value == default ? DateTimeOffset.UtcNow : value;

    private static ShapeCollectionDto ToDto(ShapeCollection c)
    {
        var bookId = NormalizeId(c.BookId);
        return new(
            Id: IdOf(c),
            BookId: string.IsNullOrEmpty(bookId) ? null : bookId,
            Name: c.Name,
            Description: c.Description,
            Source: c.Source ?? string.Empty,
            CreatedAt: Coalesce(c.CreatedAt),
            UpdatedAt: Coalesce(c.UpdatedAt)
        );
    }
}

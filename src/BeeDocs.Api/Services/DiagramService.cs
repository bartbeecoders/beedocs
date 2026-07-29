using BeeDocs.Api.Models;
using SurrealDb.Net;
using SurrealDb.Net.Models;

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

public sealed class DiagramService(ISurrealDbClient db) : IDiagramService
{
    private const string Diagrams = "diagram";
    private const string Books = "book";

    public static string DefaultBeeDiagramSource { get; } =
        """{"version":1,"nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}""";

    public async Task<IReadOnlyList<DiagramSummaryDto>> ListByBookAsync(string bookId, CancellationToken ct = default)
    {
        var rows = await db.Select<Diagram>(Diagrams, ct);
        return rows
            .Where(d => NormalizeId(d.BookId) == NormalizeId(bookId))
            .OrderByDescending(d => d.UpdatedAt)
            .ThenBy(d => d.Title)
            .Select(ToSummary)
            .ToList();
    }

    public async Task<IReadOnlyList<DiagramSummaryDto>> ListByPageAsync(string pageId, CancellationToken ct = default)
    {
        var rows = await db.Select<Diagram>(Diagrams, ct);
        return rows
            .Where(d => d.PageId is not null && NormalizeId(d.PageId) == NormalizeId(pageId))
            .OrderByDescending(d => d.UpdatedAt)
            .Select(ToSummary)
            .ToList();
    }

    public async Task<DiagramDto?> GetAsync(string id, CancellationToken ct = default)
    {
        var row = await db.Select<Diagram>(ToThing(Diagrams, id), ct);
        return row is null ? null : ToDto(row);
    }

    public async Task<DiagramDto> CreateAsync(string bookId, CreateDiagramRequest request, CancellationToken ct = default)
    {
        var book = await db.Select<Book>(ToThing(Books, bookId), ct)
            ?? throw new KeyNotFoundException($"Book '{bookId}' not found.");

        var kind = NormalizeKind(request.Kind);
        var now = DateTimeOffset.UtcNow;
        var source = string.IsNullOrWhiteSpace(request.Source)
            ? (kind == "beediagram" ? DefaultBeeDiagramSource : string.Empty)
            : request.Source;

        var diagram = new Diagram
        {
            BookId = string.IsNullOrEmpty(IdOf(book)) ? NormalizeId(bookId) : IdOf(book),
            PageId = string.IsNullOrWhiteSpace(request.PageId) ? null : NormalizeId(request.PageId),
            Title = request.Title.Trim(),
            Kind = kind,
            Source = source,
            CreatedAt = now,
            UpdatedAt = now
        };

        var created = await db.Create(Diagrams, diagram, ct)
            ?? throw new InvalidOperationException("Failed to create diagram.");
        return ToDto(created);
    }

    public async Task<DiagramDto?> UpdateAsync(string id, UpdateDiagramRequest request, CancellationToken ct = default)
    {
        var existing = await db.Select<Diagram>(ToThing(Diagrams, id), ct);
        if (existing is null) return null;

        existing.Title = request.Title.Trim();
        if (!string.IsNullOrWhiteSpace(request.Kind))
            existing.Kind = NormalizeKind(request.Kind);
        if (request.Source is not null)
            existing.Source = request.Source;
        if (request.PageId is not null)
            existing.PageId = string.IsNullOrWhiteSpace(request.PageId) ? null : NormalizeId(request.PageId);
        existing.UpdatedAt = DateTimeOffset.UtcNow;

        var updated = await db.Upsert<Diagram, Diagram>(ToThing(Diagrams, id), existing, ct);
        return updated is null ? null : ToDto(updated);
    }

    public async Task<bool> DeleteAsync(string id, CancellationToken ct = default)
    {
        var existing = await db.Select<Diagram>(ToThing(Diagrams, id), ct);
        if (existing is null) return false;
        await db.Delete(ToThing(Diagrams, id), ct);
        return true;
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

    private static DiagramSummaryDto ToSummary(Diagram d) => new(
        Id: IdOf(d),
        BookId: NormalizeId(d.BookId),
        PageId: d.PageId is null ? null : NormalizeId(d.PageId),
        Title: d.Title,
        Kind: d.Kind,
        UpdatedAt: Coalesce(d.UpdatedAt)
    );

    private static DiagramDto ToDto(Diagram d) => new(
        Id: IdOf(d),
        BookId: NormalizeId(d.BookId),
        PageId: d.PageId is null ? null : NormalizeId(d.PageId),
        Title: d.Title,
        Kind: d.Kind,
        Source: d.Source,
        CreatedAt: Coalesce(d.CreatedAt),
        UpdatedAt: Coalesce(d.UpdatedAt)
    );
}

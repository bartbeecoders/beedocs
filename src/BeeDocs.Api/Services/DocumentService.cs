using BeeDocs.Api.Models;
using SurrealDb.Net;
using SurrealDb.Net.Models;

namespace BeeDocs.Api.Services;

public interface IDocumentService
{
    Task<IReadOnlyList<BookDto>> ListBooksAsync(CancellationToken ct = default);
    Task<BookDto?> GetBookAsync(string id, CancellationToken ct = default);
    Task<BookDto> CreateBookAsync(CreateBookRequest request, CancellationToken ct = default);
    Task<BookDto?> UpdateBookAsync(string id, UpdateBookRequest request, CancellationToken ct = default);
    Task<bool> DeleteBookAsync(string id, CancellationToken ct = default);

    Task<IReadOnlyList<ChapterDto>> ListChaptersAsync(string bookId, CancellationToken ct = default);
    Task<ChapterDto> CreateChapterAsync(string bookId, CreateChapterRequest request, CancellationToken ct = default);
    Task<ChapterDto?> UpdateChapterAsync(string id, UpdateChapterRequest request, CancellationToken ct = default);
    Task<bool> DeleteChapterAsync(string id, CancellationToken ct = default);

    Task<IReadOnlyList<PageSummaryDto>> ListPagesAsync(string bookId, CancellationToken ct = default);
    Task<PageDto?> GetPageAsync(string id, CancellationToken ct = default);
    Task<PageDto> CreatePageAsync(string bookId, CreatePageRequest request, CancellationToken ct = default);
    Task<PageDto?> UpdatePageAsync(string id, UpdatePageRequest request, CancellationToken ct = default);
    Task<bool> DeletePageAsync(string id, CancellationToken ct = default);
}

public sealed class DocumentService(ISurrealDbClient db) : IDocumentService
{
    private const string Books = "book";
    private const string Chapters = "chapter";
    private const string Pages = "page";
    private const string Revisions = "page_revision";

    public async Task<IReadOnlyList<BookDto>> ListBooksAsync(CancellationToken ct = default)
    {
        var rows = await db.Select<Book>(Books, ct);
        return rows
            .OrderBy(b => b.SortOrder)
            .ThenBy(b => b.Title)
            .Select(ToDto)
            .ToList();
    }

    public async Task<BookDto?> GetBookAsync(string id, CancellationToken ct = default)
    {
        var book = await db.Select<Book>(ToThing(Books, id), ct);
        return book is null ? null : ToDto(book);
    }

    public async Task<BookDto> CreateBookAsync(CreateBookRequest request, CancellationToken ct = default)
    {
        var now = DateTimeOffset.UtcNow;
        var book = new Book
        {
            Title = request.Title.Trim(),
            Description = request.Description?.Trim(),
            Slug = string.IsNullOrWhiteSpace(request.Slug)
                ? await UniqueBookSlugAsync(SlugHelper.Slugify(request.Title), ct)
                : SlugHelper.Slugify(request.Slug),
            SortOrder = 0,
            CreatedAt = now,
            UpdatedAt = now
        };

        var created = await db.Create(Books, book, ct)
            ?? throw new InvalidOperationException("Failed to create book.");
        return ToDto(created);
    }

    public async Task<BookDto?> UpdateBookAsync(string id, UpdateBookRequest request, CancellationToken ct = default)
    {
        var existing = await db.Select<Book>(ToThing(Books, id), ct);
        if (existing is null) return null;

        existing.Title = request.Title.Trim();
        existing.Description = request.Description?.Trim();
        if (!string.IsNullOrWhiteSpace(request.Slug))
            existing.Slug = SlugHelper.Slugify(request.Slug);
        if (request.SortOrder is int order)
            existing.SortOrder = order;
        existing.UpdatedAt = DateTimeOffset.UtcNow;

        var updated = await db.Upsert<Book, Book>(ToThing(Books, id), existing, ct);
        return updated is null ? null : ToDto(updated);
    }

    public async Task<bool> DeleteBookAsync(string id, CancellationToken ct = default)
    {
        var existing = await db.Select<Book>(ToThing(Books, id), ct);
        if (existing is null) return false;

        // Cascade pages + chapters for this book
        var allPages = await db.Select<Page>(Pages, ct);
        foreach (var page in allPages.Where(p => NormalizeId(p.BookId) == NormalizeId(id)))
        {
            if (page.Id is not null)
                await db.Delete(page.Id, ct);
        }

        var allChapters = await db.Select<Chapter>(Chapters, ct);
        foreach (var chapter in allChapters.Where(c => NormalizeId(c.BookId) == NormalizeId(id)))
        {
            if (chapter.Id is not null)
                await db.Delete(chapter.Id, ct);
        }

        await db.Delete(ToThing(Books, id), ct);
        return true;
    }

    public async Task<IReadOnlyList<ChapterDto>> ListChaptersAsync(string bookId, CancellationToken ct = default)
    {
        var rows = await db.Select<Chapter>(Chapters, ct);
        return rows
            .Where(c => NormalizeId(c.BookId) == NormalizeId(bookId))
            .OrderBy(c => c.SortOrder)
            .ThenBy(c => c.Title)
            .Select(ToDto)
            .ToList();
    }

    public async Task<ChapterDto> CreateChapterAsync(string bookId, CreateChapterRequest request, CancellationToken ct = default)
    {
        var book = await db.Select<Book>(ToThing(Books, bookId), ct)
            ?? throw new KeyNotFoundException($"Book '{bookId}' not found.");

        var now = DateTimeOffset.UtcNow;
        var chapter = new Chapter
        {
            BookId = string.IsNullOrEmpty(IdOf(book)) ? NormalizeId(bookId) : IdOf(book),
            Title = request.Title.Trim(),
            Slug = string.IsNullOrWhiteSpace(request.Slug)
                ? await UniqueChapterSlugAsync(bookId, SlugHelper.Slugify(request.Title), ct)
                : SlugHelper.Slugify(request.Slug),
            SortOrder = request.SortOrder ?? 0,
            CreatedAt = now,
            UpdatedAt = now
        };

        var created = await db.Create(Chapters, chapter, ct)
            ?? throw new InvalidOperationException("Failed to create chapter.");
        return ToDto(created);
    }

    public async Task<ChapterDto?> UpdateChapterAsync(string id, UpdateChapterRequest request, CancellationToken ct = default)
    {
        var existing = await db.Select<Chapter>(ToThing(Chapters, id), ct);
        if (existing is null) return null;

        existing.Title = request.Title.Trim();
        if (!string.IsNullOrWhiteSpace(request.Slug))
            existing.Slug = await UniqueChapterSlugAsync(NormalizeId(existing.BookId), SlugHelper.Slugify(request.Slug), ct);
        if (request.SortOrder is int order)
            existing.SortOrder = order;
        existing.UpdatedAt = DateTimeOffset.UtcNow;

        var updated = await db.Upsert<Chapter, Chapter>(ToThing(Chapters, id), existing, ct);
        return updated is null ? null : ToDto(updated);
    }

    public async Task<bool> DeleteChapterAsync(string id, CancellationToken ct = default)
    {
        var existing = await db.Select<Chapter>(ToThing(Chapters, id), ct);
        if (existing is null) return false;

        var chapterId = NormalizeId(id);
        // Unlink pages in this folder (keep pages at book root)
        var allPages = await db.Select<Page>(Pages, ct);
        foreach (var page in allPages.Where(p => p.ChapterId is not null && NormalizeId(p.ChapterId) == chapterId))
        {
            page.ChapterId = null;
            page.UpdatedAt = DateTimeOffset.UtcNow;
            if (page.Id is not null)
                await db.Upsert<Page, Page>(page.Id, page, ct);
        }

        await db.Delete(ToThing(Chapters, id), ct);
        return true;
    }

    public async Task<IReadOnlyList<PageSummaryDto>> ListPagesAsync(string bookId, CancellationToken ct = default)
    {
        var rows = await db.Select<Page>(Pages, ct);
        return rows
            .Where(p => NormalizeId(p.BookId) == NormalizeId(bookId))
            .OrderBy(p => p.SortOrder)
            .ThenBy(p => p.Title)
            .Select(ToSummaryDto)
            .ToList();
    }

    public async Task<PageDto?> GetPageAsync(string id, CancellationToken ct = default)
    {
        var page = await db.Select<Page>(ToThing(Pages, id), ct);
        return page is null ? null : ToDto(page);
    }

    public async Task<PageDto> CreatePageAsync(string bookId, CreatePageRequest request, CancellationToken ct = default)
    {
        var book = await db.Select<Book>(ToThing(Books, bookId), ct)
            ?? throw new KeyNotFoundException($"Book '{bookId}' not found.");

        var now = DateTimeOffset.UtcNow;
        var page = new Page
        {
            BookId = string.IsNullOrEmpty(IdOf(book)) ? NormalizeId(bookId) : IdOf(book),
            ChapterId = string.IsNullOrWhiteSpace(request.ChapterId) ? null : NormalizeId(request.ChapterId),
            Title = request.Title.Trim(),
            Slug = string.IsNullOrWhiteSpace(request.Slug)
                ? await UniquePageSlugAsync(bookId, SlugHelper.Slugify(request.Title), ct)
                : SlugHelper.Slugify(request.Slug),
            Content = request.Content ?? string.Empty,
            SortOrder = request.SortOrder ?? 0,
            Version = 1,
            CreatedAt = now,
            UpdatedAt = now
        };

        var created = await db.Create(Pages, page, ct)
            ?? throw new InvalidOperationException("Failed to create page.");
        return ToDto(created);
    }

    public async Task<PageDto?> UpdatePageAsync(string id, UpdatePageRequest request, CancellationToken ct = default)
    {
        var existing = await db.Select<Page>(ToThing(Pages, id), ct);
        if (existing is null) return null;

        // Store revision before overwrite
        var revision = new PageRevision
        {
            PageId = NormalizeId(id),
            Version = existing.Version,
            Title = existing.Title,
            Content = existing.Content,
            CreatedAt = DateTimeOffset.UtcNow
        };
        await db.Create(Revisions, revision, ct);

        existing.Title = request.Title.Trim();
        if (!string.IsNullOrWhiteSpace(request.Slug))
            existing.Slug = SlugHelper.Slugify(request.Slug);
        if (request.Content is not null)
            existing.Content = request.Content;
        if (request.ChapterId is not null)
            existing.ChapterId = string.IsNullOrWhiteSpace(request.ChapterId) ? null : NormalizeId(request.ChapterId);
        if (request.SortOrder is int order)
            existing.SortOrder = order;
        existing.Version += 1;
        existing.UpdatedAt = DateTimeOffset.UtcNow;

        var updated = await db.Upsert<Page, Page>(ToThing(Pages, id), existing, ct);
        return updated is null ? null : ToDto(updated);
    }

    public async Task<bool> DeletePageAsync(string id, CancellationToken ct = default)
    {
        var existing = await db.Select<Page>(ToThing(Pages, id), ct);
        if (existing is null) return false;
        await db.Delete(ToThing(Pages, id), ct);
        return true;
    }

    private async Task<string> UniqueBookSlugAsync(string baseSlug, CancellationToken ct)
    {
        var books = await db.Select<Book>(Books, ct);
        return UniqueSlug(baseSlug, books.Select(b => b.Slug));
    }

    private async Task<string> UniqueChapterSlugAsync(string bookId, string baseSlug, CancellationToken ct)
    {
        var chapters = await db.Select<Chapter>(Chapters, ct);
        var existing = chapters
            .Where(c => NormalizeId(c.BookId) == NormalizeId(bookId))
            .Select(c => c.Slug);
        return UniqueSlug(baseSlug, existing);
    }

    private async Task<string> UniquePageSlugAsync(string bookId, string baseSlug, CancellationToken ct)
    {
        var pages = await db.Select<Page>(Pages, ct);
        var existing = pages
            .Where(p => NormalizeId(p.BookId) == NormalizeId(bookId))
            .Select(p => p.Slug);
        return UniqueSlug(baseSlug, existing);
    }

    private static string UniqueSlug(string baseSlug, IEnumerable<string> existing)
    {
        var set = existing.ToHashSet(StringComparer.OrdinalIgnoreCase);
        if (!set.Contains(baseSlug)) return baseSlug;
        for (var i = 2; i < 10_000; i++)
        {
            var candidate = $"{baseSlug}-{i}";
            if (!set.Contains(candidate)) return candidate;
        }
        return $"{baseSlug}-{Guid.NewGuid():N}"[..24];
    }

    private static string NormalizeId(string? id)
    {
        if (string.IsNullOrWhiteSpace(id)) return string.Empty;
        var s = id.Trim();
        var idx = s.IndexOf(':');
        return idx >= 0 ? s[(idx + 1)..] : s;
    }

    /// <summary>RecordId.ToString() returns the type name — extract the real id part.</summary>
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

    private static RecordId ToThing(string table, string id)
    {
        var raw = NormalizeId(id);
        return RecordId.From(table, raw);
    }

    private static DateTimeOffset Coalesce(DateTimeOffset value) =>
        value == default ? DateTimeOffset.UtcNow : value;

    private static BookDto ToDto(Book b) => new(
        Id: IdOf(b),
        Title: b.Title,
        Description: b.Description,
        Slug: b.Slug,
        SortOrder: b.SortOrder,
        CreatedAt: Coalesce(b.CreatedAt),
        UpdatedAt: Coalesce(b.UpdatedAt)
    );

    private static ChapterDto ToDto(Chapter c) => new(
        Id: IdOf(c),
        BookId: NormalizeId(c.BookId),
        Title: c.Title,
        Slug: c.Slug,
        SortOrder: c.SortOrder,
        CreatedAt: Coalesce(c.CreatedAt),
        UpdatedAt: Coalesce(c.UpdatedAt)
    );

    private static PageSummaryDto ToSummaryDto(Page p) => new(
        Id: IdOf(p),
        BookId: NormalizeId(p.BookId),
        ChapterId: p.ChapterId is null ? null : NormalizeId(p.ChapterId),
        Title: p.Title,
        Slug: p.Slug,
        SortOrder: p.SortOrder,
        Version: p.Version,
        UpdatedAt: Coalesce(p.UpdatedAt)
    );

    private static PageDto ToDto(Page p) => new(
        Id: IdOf(p),
        BookId: NormalizeId(p.BookId),
        ChapterId: p.ChapterId is null ? null : NormalizeId(p.ChapterId),
        Title: p.Title,
        Slug: p.Slug,
        Content: p.Content,
        SortOrder: p.SortOrder,
        Version: p.Version,
        CreatedAt: Coalesce(p.CreatedAt),
        UpdatedAt: Coalesce(p.UpdatedAt)
    );
}

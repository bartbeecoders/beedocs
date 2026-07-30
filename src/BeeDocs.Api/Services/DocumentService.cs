using BeeDocs.Api.Models;
using SurrealDb.Net;
using SurrealDb.Net.Models;

namespace BeeDocs.Api.Services;

public interface IDocumentService
{
    Task<IReadOnlyList<BookDto>> ListBooksAsync(CancellationToken ct = default);
    Task<BookDto?> GetBookAsync(string id, CancellationToken ct = default);
    Task<BookDto?> GetBookBySlugAsync(string slug, CancellationToken ct = default);
    Task<BookDto> CreateBookAsync(CreateBookRequest request, CancellationToken ct = default);
    Task<BookDto?> UpdateBookAsync(string id, UpdateBookRequest request, CancellationToken ct = default);
    Task<bool> DeleteBookAsync(string id, CancellationToken ct = default);
    /// <summary>Create or update a book by stable slug (external publish API).</summary>
    Task<UpsertResult<BookDto>> UpsertBookBySlugAsync(string slug, UpsertBookRequest request, CancellationToken ct = default);

    Task<IReadOnlyList<ChapterDto>> ListChaptersAsync(string bookId, CancellationToken ct = default);
    Task<ChapterDto> CreateChapterAsync(string bookId, CreateChapterRequest request, CancellationToken ct = default);
    Task<ChapterDto?> UpdateChapterAsync(string id, UpdateChapterRequest request, CancellationToken ct = default);
    Task<bool> DeleteChapterAsync(string id, CancellationToken ct = default);

    Task<IReadOnlyList<PageSummaryDto>> ListPagesAsync(string bookId, CancellationToken ct = default);
    Task<PageDto?> GetPageAsync(string id, CancellationToken ct = default);
    Task<PageDto?> GetPageBySlugAsync(string bookId, string pageSlug, CancellationToken ct = default);
    Task<PageDto> CreatePageAsync(string bookId, CreatePageRequest request, CancellationToken ct = default);
    Task<PageDto?> UpdatePageAsync(string id, UpdatePageRequest request, CancellationToken ct = default);
    Task<bool> DeletePageAsync(string id, CancellationToken ct = default);
    /// <summary>Create or update a page under a book by stable slug (external publish API).</summary>
    Task<UpsertResult<PageDto>> UpsertPageBySlugAsync(
        string bookId,
        string pageSlug,
        UpsertPageRequest request,
        CancellationToken ct = default);

    /// <summary>Ensure book + write page in one call (idempotent by slugs).</summary>
    Task<PublishDocumentResult> PublishDocumentAsync(PublishDocumentRequest request, CancellationToken ct = default);
}

public sealed class DocumentService(ISurrealDbClient db) : IDocumentService
{
    private const string Books = "book";
    private const string Chapters = "chapter";
    private const string ShapeCollections = "shape_collection";
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

    public async Task<BookDto?> GetBookBySlugAsync(string slug, CancellationToken ct = default)
    {
        var want = SlugHelper.Slugify(slug);
        var rows = await db.Select<Book>(Books, ct);
        var book = rows.FirstOrDefault(b =>
            string.Equals(b.Slug, want, StringComparison.OrdinalIgnoreCase));
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

        // Cascade pages, chapters and shape collections for this book
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

        // Book-scoped collections only — app-wide library entries keep living.
        var allCollections = await db.Select<ShapeCollection>(ShapeCollections, ct);
        foreach (var collection in allCollections.Where(c =>
                     !string.IsNullOrWhiteSpace(c.BookId) && NormalizeId(c.BookId) == NormalizeId(id)))
        {
            if (collection.Id is not null)
                await db.Delete(collection.Id, ct);
        }

        await db.Delete(ToThing(Books, id), ct);
        return true;
    }

    public async Task<UpsertResult<BookDto>> UpsertBookBySlugAsync(
        string slug,
        UpsertBookRequest request,
        CancellationToken ct = default)
    {
        var bookSlug = string.IsNullOrWhiteSpace(slug)
            ? SlugHelper.Slugify(request.Title ?? "book")
            : SlugHelper.Slugify(slug);

        var rows = await db.Select<Book>(Books, ct);
        var existing = rows.FirstOrDefault(b =>
            string.Equals(b.Slug, bookSlug, StringComparison.OrdinalIgnoreCase));

        if (existing is null)
        {
            var created = await CreateBookAsync(
                new CreateBookRequest(
                    Title: string.IsNullOrWhiteSpace(request.Title) ? bookSlug : request.Title.Trim(),
                    Description: request.Description,
                    Slug: bookSlug),
                ct);
            return new UpsertResult<BookDto>(created, Created: true);
        }

        var id = IdOf(existing);
        var updated = await UpdateBookAsync(
            id,
            new UpdateBookRequest(
                Title: string.IsNullOrWhiteSpace(request.Title) ? existing.Title : request.Title.Trim(),
                Description: request.Description ?? existing.Description,
                Slug: bookSlug,
                SortOrder: request.SortOrder ?? existing.SortOrder),
            ct) ?? ToDto(existing);

        return new UpsertResult<BookDto>(updated, Created: false);
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

    public async Task<PageDto?> GetPageBySlugAsync(string bookId, string pageSlug, CancellationToken ct = default)
    {
        var wantBook = NormalizeId(bookId);
        var wantSlug = SlugHelper.Slugify(pageSlug);
        var rows = await db.Select<Page>(Pages, ct);
        var page = rows.FirstOrDefault(p =>
            NormalizeId(p.BookId) == wantBook
            && string.Equals(p.Slug, wantSlug, StringComparison.OrdinalIgnoreCase));
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

    public async Task<UpsertResult<PageDto>> UpsertPageBySlugAsync(
        string bookId,
        string pageSlug,
        UpsertPageRequest request,
        CancellationToken ct = default)
    {
        var book = await GetBookAsync(bookId, ct)
            ?? throw new KeyNotFoundException($"Book '{bookId}' not found.");

        var slug = string.IsNullOrWhiteSpace(pageSlug)
            ? SlugHelper.Slugify(request.Title ?? "page")
            : SlugHelper.Slugify(pageSlug);

        var existing = await GetPageBySlugAsync(book.Id, slug, ct);
        if (existing is null)
        {
            if (request.Content is null)
                throw new ArgumentException("Content is required when creating a page.", nameof(request));

            var created = await CreatePageAsync(
                book.Id,
                new CreatePageRequest(
                    Title: string.IsNullOrWhiteSpace(request.Title) ? slug : request.Title.Trim(),
                    Slug: slug,
                    Content: request.Content,
                    ChapterId: null,
                    SortOrder: request.SortOrder),
                ct);
            return new UpsertResult<PageDto>(created, Created: true);
        }

        var updated = await UpdatePageAsync(
            existing.Id,
            new UpdatePageRequest(
                Title: string.IsNullOrWhiteSpace(request.Title) ? existing.Title : request.Title.Trim(),
                Slug: slug,
                Content: request.Content ?? existing.Content,
                ChapterId: existing.ChapterId,
                SortOrder: request.SortOrder ?? existing.SortOrder),
            ct) ?? existing;

        return new UpsertResult<PageDto>(updated, Created: false);
    }

    public async Task<PublishDocumentResult> PublishDocumentAsync(
        PublishDocumentRequest request,
        CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(request.Book);
        ArgumentNullException.ThrowIfNull(request.Page);

        if (string.IsNullOrWhiteSpace(request.Book.Title))
            throw new ArgumentException("Book title is required.", nameof(request));
        if (string.IsNullOrWhiteSpace(request.Page.Title))
            throw new ArgumentException("Page title is required.", nameof(request));
        if (request.Page.Content is null)
            throw new ArgumentException("Page content is required.", nameof(request));

        var bookSlug = string.IsNullOrWhiteSpace(request.Book.Slug)
            ? SlugHelper.Slugify(request.Book.Title)
            : SlugHelper.Slugify(request.Book.Slug);
        var pageSlug = string.IsNullOrWhiteSpace(request.Page.Slug)
            ? SlugHelper.Slugify(request.Page.Title)
            : SlugHelper.Slugify(request.Page.Slug);

        var bookResult = await UpsertBookBySlugAsync(
            bookSlug,
            new UpsertBookRequest(request.Book.Title, request.Book.Description, SortOrder: null),
            ct);

        var pageResult = await UpsertPageBySlugAsync(
            bookResult.Item.Id,
            pageSlug,
            new UpsertPageRequest(request.Page.Title, request.Page.Content, request.Page.SortOrder),
            ct);

        return new PublishDocumentResult(
            Book: bookResult.Item,
            Page: pageResult.Item,
            BookCreated: bookResult.Created,
            PageCreated: pageResult.Created);
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

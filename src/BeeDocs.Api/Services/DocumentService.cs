using BeeDocs.Api.Models;
using Microsoft.Data.Sqlite;

namespace BeeDocs.Api.Services;

public interface IDocumentService
{
    Task<IReadOnlyList<ShelfDto>> ListShelvesAsync(CancellationToken ct = default);
    Task<ShelfDto?> GetShelfAsync(string id, CancellationToken ct = default);
    Task<ShelfDto?> GetShelfBySlugAsync(string slug, CancellationToken ct = default);
    Task<ShelfDto> CreateShelfAsync(CreateShelfRequest request, CancellationToken ct = default);
    Task<ShelfDto?> UpdateShelfAsync(string id, UpdateShelfRequest request, CancellationToken ct = default);
    /// <summary>
    /// Delete the shelf. Its books survive and return to the library root — a
    /// shelf is a grouping, not a container, so nothing of substance is inside it.
    /// </summary>
    Task<bool> DeleteShelfAsync(string id, CancellationToken ct = default);
    /// <summary>Books on one shelf, in the same order the library lists them.</summary>
    Task<IReadOnlyList<BookDto>> ListShelfBooksAsync(string shelfId, CancellationToken ct = default);

    /// <summary>
    /// Resolve a shelf for <c>/bookshelf-serve/{name}</c>: slug first (title
    /// works too — it is slugified), then a raw id. Null when nothing matches.
    /// </summary>
    Task<ShelfDto?> ResolveShelfForSiteAsync(string name, CancellationToken ct = default);

    /// <summary>Nav tree for the shelf website: books, folders, page titles. Null if the shelf is missing.</summary>
    Task<BookshelfSiteDto?> GetBookshelfSiteAsync(string name, CancellationToken ct = default);

    /// <summary>One page on the shelf website. Null if the shelf, book, or page is missing or the book is not on that shelf.</summary>
    Task<BookshelfSitePageContentDto?> GetBookshelfSitePageAsync(
        string name, string bookSlug, string pageSlug, CancellationToken ct = default);

    /// <summary>True when at least one shelf is published as a public website.</summary>
    Task<bool> HasPublishedShelfAsync(CancellationToken ct = default);

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
    /// <summary>Create or update a page under a book by stable slug (external publish API).
    /// A non-null <paramref name="chapterId"/> places the page in that chapter; null leaves
    /// the page where it is (book root on create).</summary>
    Task<UpsertResult<PageDto>> UpsertPageBySlugAsync(
        string bookId,
        string pageSlug,
        UpsertPageRequest request,
        string? chapterId = null,
        CancellationToken ct = default);

    /// <summary>Ensure book + write page in one call (idempotent by slugs).</summary>
    Task<PublishDocumentResult> PublishDocumentAsync(PublishDocumentRequest request, CancellationToken ct = default);

    /// <summary>
    /// The page's change log, newest first: one entry per change, with who made
    /// it and when. Null when the page does not exist.
    /// </summary>
    Task<PageHistoryDto?> GetPageHistoryAsync(string id, int limit = 100, CancellationToken ct = default);
}

public sealed class DocumentService(SqliteConnectionFactory db, ICurrentUserAccessor currentUser) : IDocumentService
{
    /// <summary>
    /// Book columns, plus the owner's display name and the shelf's title resolved
    /// for the client — both are what a UI shows in place of a raw id.
    /// </summary>
    private const string BookSelect = """
        SELECT b.id, b.title, b.description, b.slug, b.sort_order, b.shelf_id, b.owner_id,
               b.created_at, b.updated_at,
               COALESCE(NULLIF(TRIM(u.display_name), ''), u.username) AS owner_name,
               s.title AS shelf_title
        FROM book b
        LEFT JOIN app_user u ON u.id = b.owner_id
        LEFT JOIN shelf s ON s.id = b.shelf_id
        """;

    /// <summary>
    /// Shelf columns, plus the owner's name and how many books sit on it. The
    /// count is the one fact a shelf has that is worth showing next to its title.
    /// </summary>
    private const string ShelfSelect = """
        SELECT s.id, s.title, s.description, s.slug, s.sort_order, s.published, s.owner_id,
               s.created_at, s.updated_at,
               COALESCE(NULLIF(TRIM(u.display_name), ''), u.username) AS owner_name,
               (SELECT COUNT(*) FROM book b WHERE b.shelf_id = s.id) AS book_count
        FROM shelf s
        LEFT JOIN app_user u ON u.id = s.owner_id
        """;

    /// <summary>
    /// Page columns, plus the owner's name and the author of the newest change.
    /// The change log's row for the page's current version *is* its last change,
    /// so "who touched this last" needs no extra column on the page itself.
    /// </summary>
    private const string PageSelect = """
        SELECT p.id, p.book_id, p.chapter_id, p.title, p.slug, p.content, p.sort_order, p.version,
               p.owner_id, p.created_at, p.updated_at,
               COALESCE(NULLIF(TRIM(uo.display_name), ''), uo.username) AS owner_name,
               r.changed_by, r.changed_by_name
        FROM page p
        LEFT JOIN app_user uo ON uo.id = p.owner_id
        LEFT JOIN page_revision r ON r.page_id = p.id AND r.version = p.version
        """;

    public async Task<IReadOnlyList<ShelfDto>> ListShelvesAsync(CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = $"""
            {ShelfSelect}
            ORDER BY s.sort_order, s.title COLLATE NOCASE
            """;
        var list = new List<ShelfDto>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
            list.Add(ReadShelfDto(reader));
        return list;
    }

    public async Task<ShelfDto?> GetShelfAsync(string id, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = $"{ShelfSelect} WHERE s.id = $id LIMIT 1";
        SqliteHelpers.Add(cmd, "$id", id);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        return await reader.ReadAsync(ct) ? ReadShelfDto(reader) : null;
    }

    public async Task<ShelfDto?> GetShelfBySlugAsync(string slug, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = $"{ShelfSelect} WHERE lower(s.slug) = lower($slug) LIMIT 1";
        SqliteHelpers.Add(cmd, "$slug", SlugHelper.Slugify(slug));
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        return await reader.ReadAsync(ct) ? ReadShelfDto(reader) : null;
    }

    public async Task<ShelfDto> CreateShelfAsync(CreateShelfRequest request, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var now = DateTimeOffset.UtcNow;
        var actor = currentUser.Current;
        var shelf = new Shelf
        {
            Id = SqliteHelpers.NewId(),
            Title = request.Title.Trim(),
            Description = request.Description?.Trim(),
            Slug = string.IsNullOrWhiteSpace(request.Slug)
                ? await UniqueShelfSlugAsync(conn, SlugHelper.Slugify(request.Title), ct)
                : SlugHelper.Slugify(request.Slug),
            SortOrder = 0,
            Published = request.Published ?? false,
            OwnerId = NormalizeOwnerId(request.OwnerId) ?? actor.Id,
            CreatedAt = now,
            UpdatedAt = now,
        };

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO shelf (id, title, description, slug, sort_order, published, owner_id, created_at, updated_at)
            VALUES ($id, $title, $description, $slug, $sort_order, $published, $owner_id, $created_at, $updated_at)
            """;
        SqliteHelpers.Add(cmd, "$id", shelf.Id);
        SqliteHelpers.Add(cmd, "$title", shelf.Title);
        SqliteHelpers.Add(cmd, "$description", shelf.Description);
        SqliteHelpers.Add(cmd, "$slug", shelf.Slug);
        SqliteHelpers.Add(cmd, "$sort_order", shelf.SortOrder);
        SqliteHelpers.Add(cmd, "$published", shelf.Published ? 1 : 0);
        SqliteHelpers.Add(cmd, "$owner_id", shelf.OwnerId);
        SqliteHelpers.Add(cmd, "$created_at", SqliteHelpers.FormatTimestamp(shelf.CreatedAt));
        SqliteHelpers.Add(cmd, "$updated_at", SqliteHelpers.FormatTimestamp(shelf.UpdatedAt));
        await cmd.ExecuteNonQueryAsync(ct);

        return ToDto(shelf, await OwnerNameAsync(conn, shelf.OwnerId, ct), bookCount: 0);
    }

    public async Task<ShelfDto?> UpdateShelfAsync(string id, UpdateShelfRequest request, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var existing = await SelectShelfAsync(conn, id, ct);
        if (existing is null) return null;

        existing.Title = request.Title.Trim();
        // Same as a book: null leaves the description alone, "" clears it.
        if (request.Description is not null)
            existing.Description = NormalizeText(request.Description);
        if (!string.IsNullOrWhiteSpace(request.Slug))
            existing.Slug = SlugHelper.Slugify(request.Slug);
        if (request.SortOrder is int order)
            existing.SortOrder = order;
        if (request.Published is bool published)
            existing.Published = published;
        // null leaves the owner alone, "" clears it. Anything else replaces it.
        if (request.OwnerId is not null)
            existing.OwnerId = NormalizeOwnerId(request.OwnerId);
        existing.UpdatedAt = DateTimeOffset.UtcNow;

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            UPDATE shelf SET title = $title, description = $description, slug = $slug,
              sort_order = $sort_order, published = $published, owner_id = $owner_id,
              updated_at = $updated_at
            WHERE id = $id
            """;
        SqliteHelpers.Add(cmd, "$id", existing.Id);
        SqliteHelpers.Add(cmd, "$title", existing.Title);
        SqliteHelpers.Add(cmd, "$description", existing.Description);
        SqliteHelpers.Add(cmd, "$slug", existing.Slug);
        SqliteHelpers.Add(cmd, "$sort_order", existing.SortOrder);
        SqliteHelpers.Add(cmd, "$published", existing.Published ? 1 : 0);
        SqliteHelpers.Add(cmd, "$owner_id", existing.OwnerId);
        SqliteHelpers.Add(cmd, "$updated_at", SqliteHelpers.FormatTimestamp(existing.UpdatedAt));
        await cmd.ExecuteNonQueryAsync(ct);

        return ToDto(
            existing,
            await OwnerNameAsync(conn, existing.OwnerId, ct),
            await ShelfBookCountAsync(conn, existing.Id, ct));
    }

    public async Task<bool> DeleteShelfAsync(string id, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var existing = await SelectShelfAsync(conn, id, ct);
        if (existing is null) return false;

        await using var tx = (SqliteTransaction)await conn.BeginTransactionAsync(ct);
        // Unshelve rather than cascade: a shelf groups books, it does not own their
        // content, and deleting one should never be a way to lose a library.
        await ExecAsync(conn, tx,
            "UPDATE book SET shelf_id = NULL WHERE shelf_id = $id", ("$id", id), ct);
        await ExecAsync(conn, tx, "DELETE FROM shelf WHERE id = $id", ("$id", id), ct);
        await tx.CommitAsync(ct);
        return true;
    }

    public async Task<IReadOnlyList<BookDto>> ListShelfBooksAsync(string shelfId, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = $"""
            {BookSelect}
            WHERE b.shelf_id = $shelf_id
            ORDER BY b.sort_order, b.title COLLATE NOCASE
            """;
        SqliteHelpers.Add(cmd, "$shelf_id", shelfId);
        var list = new List<BookDto>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
            list.Add(ReadBookDto(reader));
        return list;
    }

    public async Task<ShelfDto?> ResolveShelfForSiteAsync(string name, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(name)) return null;
        var trimmed = name.Trim();
        return await GetShelfBySlugAsync(trimmed, ct) ?? await GetShelfAsync(trimmed, ct);
    }

    public async Task<BookshelfSiteDto?> GetBookshelfSiteAsync(string name, CancellationToken ct = default)
    {
        var shelf = await ResolveShelfForSiteAsync(name, ct);
        if (shelf is null) return null;

        var books = await ListShelfBooksAsync(shelf.Id, ct);
        var bookIds = books.Select(b => b.Id).ToList();
        var chapters = await ListChaptersForBooksAsync(bookIds, ct);
        var pages = await ListPageSummariesForBooksAsync(bookIds, ct);

        var chaptersByBook = chapters.ToLookup(c => c.BookId, StringComparer.Ordinal);
        var pagesByBook = pages.ToLookup(p => p.BookId, StringComparer.Ordinal);

        var siteBooks = books.Select(book =>
        {
            var bookPages = pagesByBook[book.Id].ToList();
            var bookChapters = chaptersByBook[book.Id]
                .Select(ch => new BookshelfSiteChapterDto(
                    ch.Id,
                    ch.Title,
                    ch.Slug,
                    ch.SortOrder,
                    bookPages
                        .Where(p => p.ChapterId == ch.Id)
                        .Select(ToSitePage)
                        .ToList()))
                .ToList();
            var rootPages = bookPages
                .Where(p => string.IsNullOrEmpty(p.ChapterId))
                .Select(ToSitePage)
                .ToList();
            return new BookshelfSiteBookDto(
                book.Id,
                book.Title,
                book.Description,
                book.Slug,
                book.SortOrder,
                bookChapters,
                rootPages);
        }).ToList();

        return new BookshelfSiteDto(
            new BookshelfSiteShelfDto(
                shelf.Id, shelf.Title, shelf.Description, shelf.Slug, shelf.Published, shelf.BookCount),
            siteBooks);
    }

    public async Task<BookshelfSitePageContentDto?> GetBookshelfSitePageAsync(
        string name, string bookSlug, string pageSlug, CancellationToken ct = default)
    {
        var shelf = await ResolveShelfForSiteAsync(name, ct);
        if (shelf is null) return null;

        var book = await GetBookBySlugAsync(bookSlug, ct);
        if (book is null || !string.Equals(book.ShelfId, shelf.Id, StringComparison.Ordinal))
            return null;

        var page = await GetPageBySlugAsync(book.Id, pageSlug, ct);
        if (page is null) return null;

        string? chapterSlug = null;
        string? chapterTitle = null;
        if (!string.IsNullOrEmpty(page.ChapterId))
        {
            await using var conn = await db.OpenConnectionAsync(ct);
            var chapter = await SelectChapterAsync(conn, page.ChapterId, ct);
            chapterSlug = chapter?.Slug;
            chapterTitle = chapter?.Title;
        }

        return new BookshelfSitePageContentDto(
            page.Id,
            page.Title,
            page.Slug,
            page.Content,
            book.Id,
            book.Slug,
            book.Title,
            page.ChapterId,
            chapterSlug,
            chapterTitle,
            page.UpdatedAt);
    }

    public async Task<bool> HasPublishedShelfAsync(CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT 1 FROM shelf WHERE published = 1 LIMIT 1";
        var value = await cmd.ExecuteScalarAsync(ct);
        return value is not null && value is not DBNull;
    }

    public async Task<IReadOnlyList<BookDto>> ListBooksAsync(CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = $"""
            {BookSelect}
            ORDER BY b.sort_order, b.title COLLATE NOCASE
            """;
        var list = new List<BookDto>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
            list.Add(ReadBookDto(reader));
        return list;
    }

    public async Task<BookDto?> GetBookAsync(string id, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = $"{BookSelect} WHERE b.id = $id LIMIT 1";
        SqliteHelpers.Add(cmd, "$id", id);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        return await reader.ReadAsync(ct) ? ReadBookDto(reader) : null;
    }

    public async Task<BookDto?> GetBookBySlugAsync(string slug, CancellationToken ct = default)
    {
        var want = SlugHelper.Slugify(slug);
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = $"{BookSelect} WHERE lower(b.slug) = lower($slug) LIMIT 1";
        SqliteHelpers.Add(cmd, "$slug", want);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) return null;
        return ReadBookDto(reader);
    }

    public async Task<BookDto> CreateBookAsync(CreateBookRequest request, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var now = DateTimeOffset.UtcNow;
        var slug = string.IsNullOrWhiteSpace(request.Slug)
            ? await UniqueBookSlugAsync(conn, SlugHelper.Slugify(request.Title), ct)
            : SlugHelper.Slugify(request.Slug);

        // A book with no owner is a book nobody is answerable for, so the caller
        // takes it unless they said otherwise. Stays null when nobody is
        // identified — sign-in off, or an API-key caller.
        var actor = currentUser.Current;
        var book = new Book
        {
            Id = SqliteHelpers.NewId(),
            Title = request.Title.Trim(),
            Description = request.Description?.Trim(),
            Slug = slug,
            SortOrder = 0,
            ShelfId = await ResolveShelfIdAsync(conn, request.ShelfId, ct),
            OwnerId = NormalizeOwnerId(request.OwnerId) ?? actor.Id,
            CreatedAt = now,
            UpdatedAt = now,
        };

        await InsertBookAsync(conn, book, ct);
        return ToDto(
            book,
            await OwnerNameAsync(conn, book.OwnerId, ct),
            await ShelfTitleAsync(conn, book.ShelfId, ct));
    }

    public async Task<BookDto?> UpdateBookAsync(string id, UpdateBookRequest request, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var existing = await SelectBookAsync(conn, id, ct);
        if (existing is null) return null;

        existing.Title = request.Title.Trim();
        // null leaves the description alone; "" clears it. Every partial update
        // in the UI sends only the field it is changing — reading an omitted
        // description as "clear it" meant assigning an owner silently deleted
        // the book's blurb.
        if (request.Description is not null)
            existing.Description = NormalizeText(request.Description);
        if (!string.IsNullOrWhiteSpace(request.Slug))
            existing.Slug = SlugHelper.Slugify(request.Slug);
        if (request.SortOrder is int order)
            existing.SortOrder = order;
        // null leaves the owner alone, "" clears it. Anything else replaces it.
        if (request.OwnerId is not null)
            existing.OwnerId = NormalizeOwnerId(request.OwnerId);
        // Same convention for the shelf: "" is how a book is moved back to the
        // library root, and omitting it entirely leaves the book where it is.
        if (request.ShelfId is not null)
            existing.ShelfId = await ResolveShelfIdAsync(conn, request.ShelfId, ct);
        existing.UpdatedAt = DateTimeOffset.UtcNow;

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            UPDATE book SET title = $title, description = $description, slug = $slug,
              sort_order = $sort_order, shelf_id = $shelf_id, owner_id = $owner_id,
              updated_at = $updated_at
            WHERE id = $id
            """;
        SqliteHelpers.Add(cmd, "$id", existing.Id);
        SqliteHelpers.Add(cmd, "$title", existing.Title);
        SqliteHelpers.Add(cmd, "$description", existing.Description);
        SqliteHelpers.Add(cmd, "$slug", existing.Slug);
        SqliteHelpers.Add(cmd, "$sort_order", existing.SortOrder);
        SqliteHelpers.Add(cmd, "$shelf_id", existing.ShelfId);
        SqliteHelpers.Add(cmd, "$owner_id", existing.OwnerId);
        SqliteHelpers.Add(cmd, "$updated_at", SqliteHelpers.FormatTimestamp(existing.UpdatedAt));
        await cmd.ExecuteNonQueryAsync(ct);
        return ToDto(
            existing,
            await OwnerNameAsync(conn, existing.OwnerId, ct),
            await ShelfTitleAsync(conn, existing.ShelfId, ct));
    }

    public async Task<bool> DeleteBookAsync(string id, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var existing = await SelectBookAsync(conn, id, ct);
        if (existing is null) return false;

        // Cascade pages, chapters, diagrams and book-scoped shape collections.
        await using (var tx = (SqliteTransaction)await conn.BeginTransactionAsync(ct))
        {
            // Revisions first: they are addressed by page id, so deleting the
            // pages before them would strand every row in the log.
            await ExecAsync(conn, tx,
                "DELETE FROM page_revision WHERE page_id IN (SELECT id FROM page WHERE book_id = $id)",
                ("$id", id), ct);
            await ExecAsync(conn, tx, "DELETE FROM page WHERE book_id = $id", ("$id", id), ct);
            await ExecAsync(conn, tx, "DELETE FROM chapter WHERE book_id = $id", ("$id", id), ct);
            // Diagrams were missed here, so deleting a book used to strand them: no
            // longer reachable through any book, but still in the table.
            await ExecAsync(conn, tx, "DELETE FROM diagram WHERE book_id = $id", ("$id", id), ct);
            await ExecAsync(conn, tx,
                "DELETE FROM shape_collection WHERE book_id IS NOT NULL AND book_id != '' AND book_id = $id",
                ("$id", id), ct);
            await ExecAsync(conn, tx, "DELETE FROM book WHERE id = $id", ("$id", id), ct);
            await tx.CommitAsync(ct);
        }

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

        var existing = await GetBookBySlugAsync(bookSlug, ct);
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

        var updated = await UpdateBookAsync(
            existing.Id,
            new UpdateBookRequest(
                Title: string.IsNullOrWhiteSpace(request.Title) ? existing.Title : request.Title.Trim(),
                Description: request.Description ?? existing.Description,
                Slug: bookSlug,
                SortOrder: request.SortOrder ?? existing.SortOrder,
                // Publishing over a book neither reassigns nor reshelves it:
                // neither field is in UpsertBookRequest, and null means "leave
                // as it is" for both.
                OwnerId: null,
                ShelfId: null),
            ct) ?? existing;

        return new UpsertResult<BookDto>(updated, Created: false);
    }

    public async Task<IReadOnlyList<ChapterDto>> ListChaptersAsync(string bookId, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT id, book_id, title, slug, sort_order, created_at, updated_at
            FROM chapter WHERE book_id = $book_id
            ORDER BY sort_order, title COLLATE NOCASE
            """;
        SqliteHelpers.Add(cmd, "$book_id", bookId);
        var list = new List<ChapterDto>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
            list.Add(ReadChapterDto(reader));
        return list;
    }

    public async Task<ChapterDto> CreateChapterAsync(string bookId, CreateChapterRequest request, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var book = await SelectBookAsync(conn, bookId, ct)
            ?? throw new KeyNotFoundException($"Book '{bookId}' not found.");

        var now = DateTimeOffset.UtcNow;
        var chapter = new Chapter
        {
            Id = SqliteHelpers.NewId(),
            BookId = book.Id,
            Title = request.Title.Trim(),
            Slug = string.IsNullOrWhiteSpace(request.Slug)
                ? await UniqueChapterSlugAsync(conn, book.Id, SlugHelper.Slugify(request.Title), ct)
                : SlugHelper.Slugify(request.Slug),
            SortOrder = request.SortOrder ?? 0,
            CreatedAt = now,
            UpdatedAt = now,
        };

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO chapter (id, book_id, title, slug, sort_order, created_at, updated_at)
            VALUES ($id, $book_id, $title, $slug, $sort_order, $created_at, $updated_at)
            """;
        SqliteHelpers.Add(cmd, "$id", chapter.Id);
        SqliteHelpers.Add(cmd, "$book_id", chapter.BookId);
        SqliteHelpers.Add(cmd, "$title", chapter.Title);
        SqliteHelpers.Add(cmd, "$slug", chapter.Slug);
        SqliteHelpers.Add(cmd, "$sort_order", chapter.SortOrder);
        SqliteHelpers.Add(cmd, "$created_at", SqliteHelpers.FormatTimestamp(chapter.CreatedAt));
        SqliteHelpers.Add(cmd, "$updated_at", SqliteHelpers.FormatTimestamp(chapter.UpdatedAt));
        await cmd.ExecuteNonQueryAsync(ct);
        return ToDto(chapter);
    }

    public async Task<ChapterDto?> UpdateChapterAsync(string id, UpdateChapterRequest request, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var existing = await SelectChapterAsync(conn, id, ct);
        if (existing is null) return null;

        existing.Title = request.Title.Trim();
        if (!string.IsNullOrWhiteSpace(request.Slug))
            existing.Slug = await UniqueChapterSlugAsync(conn, existing.BookId, SlugHelper.Slugify(request.Slug), ct);
        if (request.SortOrder is int order)
            existing.SortOrder = order;
        existing.UpdatedAt = DateTimeOffset.UtcNow;

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            UPDATE chapter SET title = $title, slug = $slug, sort_order = $sort_order, updated_at = $updated_at
            WHERE id = $id
            """;
        SqliteHelpers.Add(cmd, "$id", existing.Id);
        SqliteHelpers.Add(cmd, "$title", existing.Title);
        SqliteHelpers.Add(cmd, "$slug", existing.Slug);
        SqliteHelpers.Add(cmd, "$sort_order", existing.SortOrder);
        SqliteHelpers.Add(cmd, "$updated_at", SqliteHelpers.FormatTimestamp(existing.UpdatedAt));
        await cmd.ExecuteNonQueryAsync(ct);
        return ToDto(existing);
    }

    public async Task<bool> DeleteChapterAsync(string id, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var existing = await SelectChapterAsync(conn, id, ct);
        if (existing is null) return false;

        await using var tx = (SqliteTransaction)await conn.BeginTransactionAsync(ct);
        await using (var unlink = conn.CreateCommand())
        {
            unlink.Transaction = tx;
            unlink.CommandText = """
                UPDATE page SET chapter_id = NULL, updated_at = $updated_at
                WHERE chapter_id = $id
                """;
            SqliteHelpers.Add(unlink, "$id", id);
            SqliteHelpers.Add(unlink, "$updated_at", SqliteHelpers.FormatTimestamp(DateTimeOffset.UtcNow));
            await unlink.ExecuteNonQueryAsync(ct);
        }

        await ExecAsync(conn, tx, "DELETE FROM chapter WHERE id = $id", ("$id", id), ct);
        await tx.CommitAsync(ct);
        return true;
    }

    public async Task<IReadOnlyList<PageSummaryDto>> ListPagesAsync(string bookId, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT p.id, p.book_id, p.chapter_id, p.title, p.slug, p.sort_order, p.version,
                   p.owner_id, COALESCE(NULLIF(TRIM(u.display_name), ''), u.username), p.updated_at
            FROM page p
            LEFT JOIN app_user u ON u.id = p.owner_id
            WHERE p.book_id = $book_id
            ORDER BY p.sort_order, p.title COLLATE NOCASE
            """;
        SqliteHelpers.Add(cmd, "$book_id", bookId);
        var list = new List<PageSummaryDto>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            list.Add(new PageSummaryDto(
                Id: reader.GetString(0),
                BookId: reader.GetString(1),
                ChapterId: SqliteHelpers.GetNullableString(reader, 2),
                Title: reader.GetString(3),
                Slug: reader.GetString(4),
                SortOrder: reader.GetInt32(5),
                Version: reader.GetInt32(6),
                OwnerId: SqliteHelpers.GetNullableString(reader, 7),
                OwnerName: SqliteHelpers.GetNullableString(reader, 8),
                UpdatedAt: Coalesce(SqliteHelpers.ReadTimestamp(reader, 9))));
        }

        return list;
    }

    public async Task<PageDto?> GetPageAsync(string id, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = $"{PageSelect} WHERE p.id = $id LIMIT 1";
        SqliteHelpers.Add(cmd, "$id", id);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        return await reader.ReadAsync(ct) ? ReadPageDto(reader) : null;
    }

    public async Task<PageDto?> GetPageBySlugAsync(string bookId, string pageSlug, CancellationToken ct = default)
    {
        var wantSlug = SlugHelper.Slugify(pageSlug);
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = $"""
            {PageSelect}
            WHERE p.book_id = $book_id AND lower(p.slug) = lower($slug)
            LIMIT 1
            """;
        SqliteHelpers.Add(cmd, "$book_id", bookId);
        SqliteHelpers.Add(cmd, "$slug", wantSlug);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        return await reader.ReadAsync(ct) ? ReadPageDto(reader) : null;
    }

    public async Task<PageDto> CreatePageAsync(string bookId, CreatePageRequest request, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var book = await SelectBookAsync(conn, bookId, ct)
            ?? throw new KeyNotFoundException($"Book '{bookId}' not found.");

        var now = DateTimeOffset.UtcNow;
        var actor = currentUser.Current;
        var page = new Page
        {
            Id = SqliteHelpers.NewId(),
            BookId = book.Id,
            ChapterId = string.IsNullOrWhiteSpace(request.ChapterId) ? null : request.ChapterId.Trim(),
            Title = request.Title.Trim(),
            Slug = string.IsNullOrWhiteSpace(request.Slug)
                ? await UniquePageSlugAsync(conn, book.Id, SlugHelper.Slugify(request.Title), ct)
                : SlugHelper.Slugify(request.Slug),
            Content = request.Content ?? string.Empty,
            SortOrder = request.SortOrder ?? 0,
            Version = 1,
            // Inherited from the book, so a page written into someone's book is
            // theirs by default. Falls back to whoever is creating it when the
            // book has no owner either.
            OwnerId = NormalizeOwnerId(request.OwnerId) ?? book.OwnerId ?? actor.Id,
            CreatedAt = now,
            UpdatedAt = now,
        };

        // Page and its first log entry in one transaction: a page whose history
        // does not start at its own creation is a history with a hole in it.
        await using (var tx = (SqliteTransaction)await conn.BeginTransactionAsync(ct))
        {
            await InsertPageAsync(conn, page, tx, ct);
            await InsertRevisionAsync(conn, tx, page, PageChangeKinds.Created, actor, now, ct);
            await tx.CommitAsync(ct);
        }

        return ToDto(page, await OwnerNameAsync(conn, page.OwnerId, ct), actor.Id, actor.Name);
    }

    public async Task<PageDto?> UpdatePageAsync(string id, UpdatePageRequest request, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var existing = await SelectPageAsync(conn, id, ct);
        if (existing is null) return null;

        await using var tx = (SqliteTransaction)await conn.BeginTransactionAsync(ct);

        existing.Title = request.Title.Trim();
        if (!string.IsNullOrWhiteSpace(request.Slug))
            existing.Slug = SlugHelper.Slugify(request.Slug);
        if (request.Content is not null)
            existing.Content = request.Content;
        if (request.ChapterId is not null)
            existing.ChapterId = string.IsNullOrWhiteSpace(request.ChapterId) ? null : request.ChapterId.Trim();
        if (request.SortOrder is int order)
            existing.SortOrder = order;
        if (request.OwnerId is not null)
            existing.OwnerId = NormalizeOwnerId(request.OwnerId);
        existing.Version += 1;
        existing.UpdatedAt = DateTimeOffset.UtcNow;

        await using (var cmd = conn.CreateCommand())
        {
            cmd.Transaction = tx;
            cmd.CommandText = """
                UPDATE page SET title = $title, slug = $slug, content = $content, chapter_id = $chapter_id,
                  sort_order = $sort_order, version = $version, owner_id = $owner_id, updated_at = $updated_at
                WHERE id = $id
                """;
            SqliteHelpers.Add(cmd, "$id", existing.Id);
            SqliteHelpers.Add(cmd, "$title", existing.Title);
            SqliteHelpers.Add(cmd, "$slug", existing.Slug);
            SqliteHelpers.Add(cmd, "$content", existing.Content);
            SqliteHelpers.Add(cmd, "$chapter_id", existing.ChapterId);
            SqliteHelpers.Add(cmd, "$sort_order", existing.SortOrder);
            SqliteHelpers.Add(cmd, "$version", existing.Version);
            SqliteHelpers.Add(cmd, "$owner_id", existing.OwnerId);
            SqliteHelpers.Add(cmd, "$updated_at", SqliteHelpers.FormatTimestamp(existing.UpdatedAt));
            await cmd.ExecuteNonQueryAsync(ct);
        }

        // Logged *after* the write and holding the new state, so the newest entry
        // always mirrors the live page and reading the log needs no off-by-one.
        var actor = currentUser.Current;
        await InsertRevisionAsync(conn, tx, existing, PageChangeKinds.Updated, actor, existing.UpdatedAt, ct);

        await tx.CommitAsync(ct);
        return ToDto(existing, await OwnerNameAsync(conn, existing.OwnerId, ct), actor.Id, actor.Name);
    }

    public async Task<bool> DeletePageAsync(string id, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var existing = await SelectPageAsync(conn, id, ct);
        if (existing is null) return false;

        await using var tx = (SqliteTransaction)await conn.BeginTransactionAsync(ct);
        await ExecAsync(conn, tx, "DELETE FROM page_revision WHERE page_id = $id", ("$id", id), ct);
        await ExecAsync(conn, tx, "DELETE FROM page WHERE id = $id", ("$id", id), ct);
        await tx.CommitAsync(ct);
        return true;
    }

    public async Task<UpsertResult<PageDto>> UpsertPageBySlugAsync(
        string bookId,
        string pageSlug,
        UpsertPageRequest request,
        string? chapterId = null,
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
                    ChapterId: chapterId,
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
                ChapterId: chapterId ?? existing.ChapterId,
                SortOrder: request.SortOrder ?? existing.SortOrder,
                // Republishing does not reassign the page — null leaves it alone.
                OwnerId: null),
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
        var book = bookResult.Item;

        // Optional shelf: match by slug, create when missing, and move the book onto
        // it. An existing shelf is used as-is (its title is not renamed by a publish).
        // Omitting the shelf leaves the book wherever it already sits — same
        // "absent means untouched" rule the folder uses for the page.
        ShelfDto? shelf = null;
        var shelfCreated = false;
        if (request.Shelf is not null)
        {
            if (string.IsNullOrWhiteSpace(request.Shelf.Title))
                throw new ArgumentException("Shelf title is required when a shelf is specified.", nameof(request));

            var shelfSlug = string.IsNullOrWhiteSpace(request.Shelf.Slug)
                ? SlugHelper.Slugify(request.Shelf.Title)
                : SlugHelper.Slugify(request.Shelf.Slug);

            shelf = await GetShelfBySlugAsync(shelfSlug, ct);
            if (shelf is null)
            {
                shelf = await CreateShelfAsync(
                    new CreateShelfRequest(request.Shelf.Title.Trim(), Description: null, Slug: shelfSlug),
                    ct);
                shelfCreated = true;
            }

            if (!string.Equals(book.ShelfId, shelf.Id, StringComparison.Ordinal))
            {
                book = await UpdateBookAsync(
                    book.Id,
                    new UpdateBookRequest(
                        Title: book.Title,
                        Description: null,
                        Slug: null,
                        SortOrder: null,
                        OwnerId: null,
                        ShelfId: shelf.Id),
                    ct) ?? book;
            }
        }

        // Optional folder (chapter): match by slug within the book, create when missing.
        // An existing folder is used as-is (its title is not renamed by a publish).
        ChapterDto? folder = null;
        var folderCreated = false;
        if (request.Folder is not null)
        {
            if (string.IsNullOrWhiteSpace(request.Folder.Title))
                throw new ArgumentException("Folder title is required when a folder is specified.", nameof(request));

            var folderSlug = string.IsNullOrWhiteSpace(request.Folder.Slug)
                ? SlugHelper.Slugify(request.Folder.Title)
                : SlugHelper.Slugify(request.Folder.Slug);

            var chapters = await ListChaptersAsync(book.Id, ct);
            folder = chapters.FirstOrDefault(c =>
                string.Equals(c.Slug, folderSlug, StringComparison.OrdinalIgnoreCase));
            if (folder is null)
            {
                folder = await CreateChapterAsync(
                    book.Id,
                    new CreateChapterRequest(request.Folder.Title.Trim(), folderSlug, SortOrder: null),
                    ct);
                folderCreated = true;
            }
        }

        var pageResult = await UpsertPageBySlugAsync(
            book.Id,
            pageSlug,
            new UpsertPageRequest(request.Page.Title, request.Page.Content, request.Page.SortOrder),
            folder?.Id,
            ct);

        return new PublishDocumentResult(
            Book: book,
            Page: pageResult.Item,
            BookCreated: bookResult.Created,
            PageCreated: pageResult.Created,
            Folder: folder,
            FolderCreated: folderCreated,
            Shelf: shelf,
            ShelfCreated: shelfCreated);
    }

    public async Task<PageHistoryDto?> GetPageHistoryAsync(
        string id,
        int limit = 100,
        CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var page = await SelectPageAsync(conn, id, ct);
        if (page is null) return null;

        var take = Math.Clamp(limit, 1, 500);
        var entries = new List<PageHistoryEntryDto>();

        await using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = """
                SELECT id, version, title, change_kind, changed_by, changed_by_name, created_at
                FROM page_revision
                WHERE page_id = $page_id
                ORDER BY version DESC, created_at DESC
                LIMIT $limit
                """;
            SqliteHelpers.Add(cmd, "$page_id", page.Id);
            SqliteHelpers.Add(cmd, "$limit", take);

            await using var reader = await cmd.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
            {
                var version = reader.GetInt32(1);
                entries.Add(new PageHistoryEntryDto(
                    Id: reader.GetString(0),
                    Version: version,
                    Title: reader.GetString(2),
                    ChangeKind: reader.IsDBNull(3) ? PageChangeKinds.Updated : reader.GetString(3),
                    ChangedById: SqliteHelpers.GetNullableString(reader, 4),
                    ChangedByName: SqliteHelpers.GetNullableString(reader, 5),
                    ChangedAt: Coalesce(SqliteHelpers.ReadTimestamp(reader, 6)),
                    IsCurrent: version == page.Version));
            }
        }

        // A page last written before the change log existed has no entry for the
        // version it is sitting on. Synthesising one from the page itself keeps
        // the newest row and the live page in step — with no author, because
        // there genuinely is no record of one.
        if (!entries.Any(e => e.IsCurrent))
        {
            entries.Insert(0, new PageHistoryEntryDto(
                Id: $"current:{page.Id}",
                Version: page.Version,
                Title: page.Title,
                ChangeKind: PageChangeKinds.Legacy,
                ChangedById: null,
                ChangedByName: null,
                ChangedAt: Coalesce(page.UpdatedAt),
                IsCurrent: true));
        }

        return new PageHistoryDto(page.Id, page.Title, page.Version, entries);
    }

    private static async Task InsertRevisionAsync(
        SqliteConnection conn,
        SqliteTransaction? tx,
        Page page,
        string changeKind,
        CurrentActor actor,
        DateTimeOffset changedAt,
        CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = """
            INSERT INTO page_revision
              (id, page_id, version, title, content, changed_by, changed_by_name, change_kind, created_at)
            VALUES
              ($id, $page_id, $version, $title, $content, $changed_by, $changed_by_name, $change_kind, $created_at)
            """;
        SqliteHelpers.Add(cmd, "$id", SqliteHelpers.NewId());
        SqliteHelpers.Add(cmd, "$page_id", page.Id);
        SqliteHelpers.Add(cmd, "$version", page.Version);
        SqliteHelpers.Add(cmd, "$title", page.Title);
        SqliteHelpers.Add(cmd, "$content", page.Content);
        SqliteHelpers.Add(cmd, "$changed_by", actor.Id);
        SqliteHelpers.Add(cmd, "$changed_by_name", actor.Name);
        SqliteHelpers.Add(cmd, "$change_kind", changeKind);
        SqliteHelpers.Add(cmd, "$created_at", SqliteHelpers.FormatTimestamp(changedAt));
        await cmd.ExecuteNonQueryAsync(ct);
    }

    /// <summary>Display name for an owner id — what the client shows instead of a raw id.</summary>
    private static async Task<string?> OwnerNameAsync(SqliteConnection conn, string? ownerId, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(ownerId)) return null;

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT COALESCE(NULLIF(TRIM(display_name), ''), username) FROM app_user WHERE id = $id LIMIT 1
            """;
        SqliteHelpers.Add(cmd, "$id", ownerId);
        return await cmd.ExecuteScalarAsync(ct) as string;
    }

    /// <summary>Title for a shelf id — what the client shows instead of a raw id.</summary>
    private static async Task<string?> ShelfTitleAsync(SqliteConnection conn, string? shelfId, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(shelfId)) return null;

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT title FROM shelf WHERE id = $id LIMIT 1";
        SqliteHelpers.Add(cmd, "$id", shelfId);
        return await cmd.ExecuteScalarAsync(ct) as string;
    }

    private static async Task<int> ShelfBookCountAsync(SqliteConnection conn, string shelfId, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM book WHERE shelf_id = $id";
        SqliteHelpers.Add(cmd, "$id", shelfId);
        return Convert.ToInt32(await cmd.ExecuteScalarAsync(ct) ?? 0);
    }

    /// <summary>
    /// Blank means "the library root". A shelf id that names nothing is rejected
    /// rather than stored: a book pointing at a missing shelf would vanish from
    /// both the shelf listing and the unshelved one.
    /// </summary>
    private static async Task<string?> ResolveShelfIdAsync(
        SqliteConnection conn, string? raw, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;

        var id = raw.Trim();
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT 1 FROM shelf WHERE id = $id LIMIT 1";
        SqliteHelpers.Add(cmd, "$id", id);
        if (await cmd.ExecuteScalarAsync(ct) is null)
            throw new KeyNotFoundException($"Shelf '{id}' not found.");
        return id;
    }

    /// <summary>Blank means "no owner"; the API takes "" as an explicit clear.</summary>
    private static string? NormalizeOwnerId(string? raw) =>
        string.IsNullOrWhiteSpace(raw) ? null : raw.Trim();

    /// <summary>Trimmed, with blank stored as NULL rather than an empty string.</summary>
    private static string? NormalizeText(string raw) =>
        string.IsNullOrWhiteSpace(raw) ? null : raw.Trim();

    private static async Task InsertBookAsync(SqliteConnection conn, Book book, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO book (id, title, description, slug, sort_order, shelf_id, owner_id, created_at, updated_at)
            VALUES ($id, $title, $description, $slug, $sort_order, $shelf_id, $owner_id, $created_at, $updated_at)
            """;
        SqliteHelpers.Add(cmd, "$id", book.Id);
        SqliteHelpers.Add(cmd, "$title", book.Title);
        SqliteHelpers.Add(cmd, "$description", book.Description);
        SqliteHelpers.Add(cmd, "$slug", book.Slug);
        SqliteHelpers.Add(cmd, "$sort_order", book.SortOrder);
        SqliteHelpers.Add(cmd, "$shelf_id", book.ShelfId);
        SqliteHelpers.Add(cmd, "$owner_id", book.OwnerId);
        SqliteHelpers.Add(cmd, "$created_at", SqliteHelpers.FormatTimestamp(book.CreatedAt));
        SqliteHelpers.Add(cmd, "$updated_at", SqliteHelpers.FormatTimestamp(book.UpdatedAt));
        await cmd.ExecuteNonQueryAsync(ct);
    }

    private static async Task InsertPageAsync(
        SqliteConnection conn,
        Page page,
        SqliteTransaction? tx,
        CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = """
            INSERT INTO page (id, book_id, chapter_id, title, slug, content, sort_order, version, owner_id, created_at, updated_at)
            VALUES ($id, $book_id, $chapter_id, $title, $slug, $content, $sort_order, $version, $owner_id, $created_at, $updated_at)
            """;
        SqliteHelpers.Add(cmd, "$id", page.Id);
        SqliteHelpers.Add(cmd, "$book_id", page.BookId);
        SqliteHelpers.Add(cmd, "$chapter_id", page.ChapterId);
        SqliteHelpers.Add(cmd, "$title", page.Title);
        SqliteHelpers.Add(cmd, "$slug", page.Slug);
        SqliteHelpers.Add(cmd, "$content", page.Content);
        SqliteHelpers.Add(cmd, "$sort_order", page.SortOrder);
        SqliteHelpers.Add(cmd, "$version", page.Version);
        SqliteHelpers.Add(cmd, "$owner_id", page.OwnerId);
        SqliteHelpers.Add(cmd, "$created_at", SqliteHelpers.FormatTimestamp(page.CreatedAt));
        SqliteHelpers.Add(cmd, "$updated_at", SqliteHelpers.FormatTimestamp(page.UpdatedAt));
        await cmd.ExecuteNonQueryAsync(ct);
    }

    private static async Task<Book?> SelectBookAsync(SqliteConnection conn, string id, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT id, title, description, slug, sort_order, shelf_id, owner_id, created_at, updated_at
            FROM book WHERE id = $id LIMIT 1
            """;
        SqliteHelpers.Add(cmd, "$id", id);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) return null;
        return new Book
        {
            Id = reader.GetString(0),
            Title = reader.GetString(1),
            Description = SqliteHelpers.GetNullableString(reader, 2),
            Slug = reader.GetString(3),
            SortOrder = reader.GetInt32(4),
            ShelfId = SqliteHelpers.GetNullableString(reader, 5),
            OwnerId = SqliteHelpers.GetNullableString(reader, 6),
            CreatedAt = SqliteHelpers.ReadTimestamp(reader, 7),
            UpdatedAt = SqliteHelpers.ReadTimestamp(reader, 8),
        };
    }

    private static async Task<Shelf?> SelectShelfAsync(SqliteConnection conn, string id, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT id, title, description, slug, sort_order, published, owner_id, created_at, updated_at
            FROM shelf WHERE id = $id LIMIT 1
            """;
        SqliteHelpers.Add(cmd, "$id", id);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) return null;
        return new Shelf
        {
            Id = reader.GetString(0),
            Title = reader.GetString(1),
            Description = SqliteHelpers.GetNullableString(reader, 2),
            Slug = reader.GetString(3),
            SortOrder = reader.GetInt32(4),
            Published = ReadFlag(reader, 5),
            OwnerId = SqliteHelpers.GetNullableString(reader, 6),
            CreatedAt = SqliteHelpers.ReadTimestamp(reader, 7),
            UpdatedAt = SqliteHelpers.ReadTimestamp(reader, 8),
        };
    }

    private static async Task<Chapter?> SelectChapterAsync(SqliteConnection conn, string id, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT id, book_id, title, slug, sort_order, created_at, updated_at
            FROM chapter WHERE id = $id LIMIT 1
            """;
        SqliteHelpers.Add(cmd, "$id", id);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) return null;
        return new Chapter
        {
            Id = reader.GetString(0),
            BookId = reader.GetString(1),
            Title = reader.GetString(2),
            Slug = reader.GetString(3),
            SortOrder = reader.GetInt32(4),
            CreatedAt = SqliteHelpers.ReadTimestamp(reader, 5),
            UpdatedAt = SqliteHelpers.ReadTimestamp(reader, 6),
        };
    }

    private static async Task<Page?> SelectPageAsync(SqliteConnection conn, string id, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT id, book_id, chapter_id, title, slug, content, sort_order, version, owner_id, created_at, updated_at
            FROM page WHERE id = $id LIMIT 1
            """;
        SqliteHelpers.Add(cmd, "$id", id);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) return null;
        return ReadPage(reader);
    }

    private static Page ReadPage(SqliteDataReader reader) => new()
    {
        Id = reader.GetString(0),
        BookId = reader.GetString(1),
        ChapterId = SqliteHelpers.GetNullableString(reader, 2),
        Title = reader.GetString(3),
        Slug = reader.GetString(4),
        Content = reader.GetString(5),
        SortOrder = reader.GetInt32(6),
        Version = reader.GetInt32(7),
        OwnerId = SqliteHelpers.GetNullableString(reader, 8),
        CreatedAt = SqliteHelpers.ReadTimestamp(reader, 9),
        UpdatedAt = SqliteHelpers.ReadTimestamp(reader, 10),
    };

    private static async Task<string> UniqueShelfSlugAsync(SqliteConnection conn, string baseSlug, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT slug FROM shelf";
        var existing = new List<string>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
            existing.Add(reader.GetString(0));
        return UniqueSlug(baseSlug, existing);
    }

    private static async Task<string> UniqueBookSlugAsync(SqliteConnection conn, string baseSlug, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT slug FROM book";
        var existing = new List<string>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
            existing.Add(reader.GetString(0));
        return UniqueSlug(baseSlug, existing);
    }

    private static async Task<string> UniqueChapterSlugAsync(
        SqliteConnection conn, string bookId, string baseSlug, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT slug FROM chapter WHERE book_id = $book_id";
        SqliteHelpers.Add(cmd, "$book_id", bookId);
        var existing = new List<string>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
            existing.Add(reader.GetString(0));
        return UniqueSlug(baseSlug, existing);
    }

    private static async Task<string> UniquePageSlugAsync(
        SqliteConnection conn, string bookId, string baseSlug, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT slug FROM page WHERE book_id = $book_id";
        SqliteHelpers.Add(cmd, "$book_id", bookId);
        var existing = new List<string>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
            existing.Add(reader.GetString(0));
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

    private static async Task ExecAsync(
        SqliteConnection conn,
        SqliteTransaction? tx,
        string sql,
        (string Name, object? Value) param,
        CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = sql;
        SqliteHelpers.Add(cmd, param.Name, param.Value);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    private static DateTimeOffset Coalesce(DateTimeOffset value) =>
        value == default ? DateTimeOffset.UtcNow : value;

    private static bool ReadFlag(SqliteDataReader reader, int ordinal) =>
        !reader.IsDBNull(ordinal) && reader.GetInt32(ordinal) != 0;

    private static BookshelfSitePageDto ToSitePage(PageSummaryDto p) =>
        new(p.Id, p.Title, p.Slug, p.SortOrder, p.UpdatedAt);

    private async Task<List<ChapterDto>> ListChaptersForBooksAsync(
        IReadOnlyList<string> bookIds, CancellationToken ct)
    {
        var list = new List<ChapterDto>();
        if (bookIds.Count == 0) return list;

        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        var names = bookIds.Select((_, i) => $"$b{i}").ToArray();
        cmd.CommandText = $"""
            SELECT id, book_id, title, slug, sort_order, created_at, updated_at
            FROM chapter
            WHERE book_id IN ({string.Join(", ", names)})
            ORDER BY sort_order, title COLLATE NOCASE
            """;
        for (var i = 0; i < bookIds.Count; i++)
            SqliteHelpers.Add(cmd, names[i], bookIds[i]);

        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
            list.Add(ReadChapterDto(reader));
        return list;
    }

    private async Task<List<PageSummaryDto>> ListPageSummariesForBooksAsync(
        IReadOnlyList<string> bookIds, CancellationToken ct)
    {
        var list = new List<PageSummaryDto>();
        if (bookIds.Count == 0) return list;

        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        var names = bookIds.Select((_, i) => $"$b{i}").ToArray();
        cmd.CommandText = $"""
            SELECT p.id, p.book_id, p.chapter_id, p.title, p.slug, p.sort_order, p.version,
                   p.owner_id, p.updated_at,
                   COALESCE(NULLIF(TRIM(u.display_name), ''), u.username) AS owner_name
            FROM page p
            LEFT JOIN app_user u ON u.id = p.owner_id
            WHERE p.book_id IN ({string.Join(", ", names)})
            ORDER BY p.sort_order, p.title COLLATE NOCASE
            """;
        for (var i = 0; i < bookIds.Count; i++)
            SqliteHelpers.Add(cmd, names[i], bookIds[i]);

        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            list.Add(new PageSummaryDto(
                Id: reader.GetString(0),
                BookId: reader.GetString(1),
                ChapterId: SqliteHelpers.GetNullableString(reader, 2),
                Title: reader.GetString(3),
                Slug: reader.GetString(4),
                SortOrder: reader.GetInt32(5),
                Version: reader.GetInt32(6),
                OwnerId: SqliteHelpers.GetNullableString(reader, 7),
                OwnerName: SqliteHelpers.GetNullableString(reader, 9),
                UpdatedAt: Coalesce(SqliteHelpers.ReadTimestamp(reader, 8))));
        }
        return list;
    }

    /// <summary>Reads a row shaped by <see cref="BookSelect"/>.</summary>
    private static BookDto ReadBookDto(SqliteDataReader reader) => new(
        Id: reader.GetString(0),
        Title: reader.GetString(1),
        Description: SqliteHelpers.GetNullableString(reader, 2),
        Slug: reader.GetString(3),
        SortOrder: reader.GetInt32(4),
        ShelfId: SqliteHelpers.GetNullableString(reader, 5),
        OwnerId: SqliteHelpers.GetNullableString(reader, 6),
        CreatedAt: Coalesce(SqliteHelpers.ReadTimestamp(reader, 7)),
        UpdatedAt: Coalesce(SqliteHelpers.ReadTimestamp(reader, 8)),
        OwnerName: SqliteHelpers.GetNullableString(reader, 9),
        ShelfTitle: SqliteHelpers.GetNullableString(reader, 10));

    /// <summary>Reads a row shaped by <see cref="ShelfSelect"/>.</summary>
    private static ShelfDto ReadShelfDto(SqliteDataReader reader) => new(
        Id: reader.GetString(0),
        Title: reader.GetString(1),
        Description: SqliteHelpers.GetNullableString(reader, 2),
        Slug: reader.GetString(3),
        SortOrder: reader.GetInt32(4),
        Published: ReadFlag(reader, 5),
        OwnerId: SqliteHelpers.GetNullableString(reader, 6),
        CreatedAt: Coalesce(SqliteHelpers.ReadTimestamp(reader, 7)),
        UpdatedAt: Coalesce(SqliteHelpers.ReadTimestamp(reader, 8)),
        OwnerName: SqliteHelpers.GetNullableString(reader, 9),
        BookCount: reader.GetInt32(10));

    /// <summary>Reads a row shaped by <see cref="PageSelect"/>.</summary>
    private static PageDto ReadPageDto(SqliteDataReader reader) => new(
        Id: reader.GetString(0),
        BookId: reader.GetString(1),
        ChapterId: SqliteHelpers.GetNullableString(reader, 2),
        Title: reader.GetString(3),
        Slug: reader.GetString(4),
        Content: reader.GetString(5),
        SortOrder: reader.GetInt32(6),
        Version: reader.GetInt32(7),
        OwnerId: SqliteHelpers.GetNullableString(reader, 8),
        CreatedAt: Coalesce(SqliteHelpers.ReadTimestamp(reader, 9)),
        UpdatedAt: Coalesce(SqliteHelpers.ReadTimestamp(reader, 10)),
        OwnerName: SqliteHelpers.GetNullableString(reader, 11),
        UpdatedById: SqliteHelpers.GetNullableString(reader, 12),
        UpdatedByName: SqliteHelpers.GetNullableString(reader, 13));

    private static ChapterDto ReadChapterDto(SqliteDataReader reader) => new(
        Id: reader.GetString(0),
        BookId: reader.GetString(1),
        Title: reader.GetString(2),
        Slug: reader.GetString(3),
        SortOrder: reader.GetInt32(4),
        CreatedAt: Coalesce(SqliteHelpers.ReadTimestamp(reader, 5)),
        UpdatedAt: Coalesce(SqliteHelpers.ReadTimestamp(reader, 6)));

    private static BookDto ToDto(Book b, string? ownerName, string? shelfTitle) => new(
        Id: b.Id,
        Title: b.Title,
        Description: b.Description,
        Slug: b.Slug,
        SortOrder: b.SortOrder,
        ShelfId: b.ShelfId,
        ShelfTitle: shelfTitle,
        OwnerId: b.OwnerId,
        OwnerName: ownerName,
        CreatedAt: Coalesce(b.CreatedAt),
        UpdatedAt: Coalesce(b.UpdatedAt));

    private static ShelfDto ToDto(Shelf s, string? ownerName, int bookCount) => new(
        Id: s.Id,
        Title: s.Title,
        Description: s.Description,
        Slug: s.Slug,
        SortOrder: s.SortOrder,
        Published: s.Published,
        OwnerId: s.OwnerId,
        OwnerName: ownerName,
        BookCount: bookCount,
        CreatedAt: Coalesce(s.CreatedAt),
        UpdatedAt: Coalesce(s.UpdatedAt));

    private static ChapterDto ToDto(Chapter c) => new(
        Id: c.Id,
        BookId: c.BookId,
        Title: c.Title,
        Slug: c.Slug,
        SortOrder: c.SortOrder,
        CreatedAt: Coalesce(c.CreatedAt),
        UpdatedAt: Coalesce(c.UpdatedAt));

    private static PageDto ToDto(Page p, string? ownerName, string? updatedById, string? updatedByName) => new(
        Id: p.Id,
        BookId: p.BookId,
        ChapterId: p.ChapterId,
        Title: p.Title,
        Slug: p.Slug,
        Content: p.Content,
        SortOrder: p.SortOrder,
        Version: p.Version,
        OwnerId: p.OwnerId,
        OwnerName: ownerName,
        UpdatedById: updatedById,
        UpdatedByName: updatedByName,
        CreatedAt: Coalesce(p.CreatedAt),
        UpdatedAt: Coalesce(p.UpdatedAt));
}

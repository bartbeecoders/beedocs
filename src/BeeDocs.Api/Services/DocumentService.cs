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

    /// <summary>
    /// One kept copy of a page, in full. Null when the page or revision is
    /// unknown — or when the page does not have change tracking switched on,
    /// which is the owner's call to make.
    /// </summary>
    Task<PageRevisionDto?> GetPageRevisionAsync(string pageId, string revisionId, CancellationToken ct = default);
}

public sealed class DocumentService(
    SqliteConnectionFactory db,
    ICurrentUserAccessor currentUser,
    ContentResolver resolver,
    ShelfContentMover mover,
    StorageOptions storage) : IDocumentService
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
               (SELECT COUNT(*) FROM book b WHERE b.shelf_id = s.id) AS book_count,
               s.storage_provider_id,
               sp.name AS storage_provider_name
        FROM shelf s
        LEFT JOIN app_user u ON u.id = s.owner_id
        LEFT JOIN storage_provider sp ON sp.id = s.storage_provider_id
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
               r.changed_by, r.changed_by_name,
               p.track_changes, p.max_revisions, p.content_ref
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
            await ShelfBookCountAsync(conn, existing.Id, ct),
            await StorageProviderNameAsync(conn, existing.StorageProviderId, ct));
    }

    public async Task<bool> DeleteShelfAsync(string id, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var existing = await SelectShelfAsync(conn, id, ct);
        if (existing is null) return false;

        // The books survive the shelf, so their content must be back in SQLite
        // before they return to the library root — unshelving them while their
        // bodies sit at a provider nothing points to anymore would strand them.
        // A failure aborts the delete; re-running resumes where this stopped.
        if (existing.StorageProviderId is not null)
        {
            var report = await mover.MoveShelfContentAsync(id, targetProviderId: null, ct);
            if (report.Errors.Count > 0)
            {
                throw new ContentUnavailableException(
                    "shelf storage",
                    $"Could not bring all content back from the shelf's storage provider "
                    + $"({report.Errors.Count} item(s) failed). Fix the provider and delete again.");
            }
        }

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
        var previousShelfId = existing.ShelfId;
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

        // A book that changed shelves may now sit under a different storage
        // provider — its bodies follow it. The book row is already committed and
        // every content row self-describes, so a partial relocation here is
        // readable and resumed by the next move; the mover logs failures.
        if (!string.Equals(previousShelfId, existing.ShelfId, StringComparison.Ordinal))
        {
            var target = await ContentResolver.ProviderIdForBookAsync(conn, existing.Id, ct);
            await mover.MoveBookContentAsync(existing.Id, target, ct);
        }

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

        // Refs first: the rows are gone after the cascade, and the cloud objects
        // they point at are deleted best-effort only after the commit. Attachment
        // files on disk are collected here for the same reason.
        var cloudRefs = await CollectBookContentRefsAsync(conn, id, ct);
        var attachmentFiles = await CollectBookAttachmentFilesAsync(conn, id, ct);

        // Cascade pages, chapters, diagrams, slide decks, attachments and
        // book-scoped shape collections.
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
            await ExecAsync(conn, tx, "DELETE FROM slide_deck WHERE book_id = $id", ("$id", id), ct);
            await ExecAsync(conn, tx, "DELETE FROM attachment WHERE book_id = $id", ("$id", id), ct);
            await ExecAsync(conn, tx,
                "DELETE FROM shape_collection WHERE book_id IS NOT NULL AND book_id != '' AND book_id = $id",
                ("$id", id), ct);
            await ExecAsync(conn, tx, "DELETE FROM book WHERE id = $id", ("$id", id), ct);
            await tx.CommitAsync(ct);
        }

        await resolver.DeleteAllAsync(cloudRefs, ct);
        AttachmentService.DeleteFiles(storage.AttachmentsRoot, attachmentFiles);
        return true;
    }

    /// <summary>
    /// The on-disk names of every attachment in a book, read before the cascade
    /// removes the rows that know them.
    /// </summary>
    private static async Task<IReadOnlyList<string>> CollectBookAttachmentFilesAsync(
        SqliteConnection conn, string bookId, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT stored_name FROM attachment WHERE book_id = $id";
        SqliteHelpers.Add(cmd, "$id", bookId);
        var names = new List<string>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
            names.Add(reader.GetString(0));
        return names;
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

        if (!string.IsNullOrWhiteSpace(request.Title))
            existing.Title = request.Title.Trim();
        if (!string.IsNullOrWhiteSpace(request.Slug))
            existing.Slug = SlugHelper.Slugify(request.Slug);

        var destBookId = string.IsNullOrWhiteSpace(request.BookId) ? null : request.BookId.Trim();
        var moving = destBookId is not null
            && !string.Equals(destBookId, existing.BookId, StringComparison.Ordinal);
        if (moving)
        {
            await MoveChapterToBookAsync(conn, existing, destBookId!, request.SortOrder, ct);
            return ToDto(existing);
        }

        if (!string.IsNullOrWhiteSpace(request.Slug))
            existing.Slug = await UniqueChapterSlugAsync(conn, existing.BookId, existing.Slug, ct);
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

    /// <summary>
    /// Relocate a folder into another book, taking its pages (and any diagrams
    /// linked to those pages) with it. Slugs are unique-ified against the
    /// destination; bodies follow if the two books sit on different storage.
    /// </summary>
    private async Task MoveChapterToBookAsync(
        SqliteConnection conn,
        Chapter existing,
        string destBookId,
        int? requestedSortOrder,
        CancellationToken ct)
    {
        var dest = await SelectBookAsync(conn, destBookId, ct)
            ?? throw new KeyNotFoundException($"Book '{destBookId}' was not found.");

        var sourceProvider = await ContentResolver.ProviderIdForBookAsync(conn, existing.BookId, ct);
        var destProvider = await ContentResolver.ProviderIdForBookAsync(conn, dest.Id, ct);

        existing.Slug = await UniqueChapterSlugAsync(conn, dest.Id, existing.Slug, ct);
        existing.SortOrder = requestedSortOrder
            ?? await NextChapterSortOrderAsync(conn, dest.Id, ct);
        existing.BookId = dest.Id;
        existing.UpdatedAt = DateTimeOffset.UtcNow;

        var pages = new List<(string Id, string Slug)>();
        await using (var list = conn.CreateCommand())
        {
            list.CommandText = "SELECT id, slug FROM page WHERE chapter_id = $id";
            SqliteHelpers.Add(list, "$id", existing.Id);
            await using var reader = await list.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
                pages.Add((reader.GetString(0), reader.GetString(1)));
        }

        var destSlugs = new List<string>();
        await using (var slugs = conn.CreateCommand())
        {
            slugs.CommandText = "SELECT slug FROM page WHERE book_id = $book_id";
            SqliteHelpers.Add(slugs, "$book_id", dest.Id);
            await using var reader = await slugs.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
                destSlugs.Add(reader.GetString(0));
        }

        var newSlugs = new List<(string Id, string Slug)>(pages.Count);
        foreach (var (pageId, slug) in pages)
        {
            var unique = UniqueSlug(slug, destSlugs);
            destSlugs.Add(unique);
            newSlugs.Add((pageId, unique));
        }

        await using var tx = (SqliteTransaction)await conn.BeginTransactionAsync(ct);
        await using (var upd = conn.CreateCommand())
        {
            upd.Transaction = tx;
            upd.CommandText = """
                UPDATE chapter SET book_id = $book_id, title = $title, slug = $slug,
                  sort_order = $sort_order, updated_at = $updated_at
                WHERE id = $id
                """;
            SqliteHelpers.Add(upd, "$id", existing.Id);
            SqliteHelpers.Add(upd, "$book_id", existing.BookId);
            SqliteHelpers.Add(upd, "$title", existing.Title);
            SqliteHelpers.Add(upd, "$slug", existing.Slug);
            SqliteHelpers.Add(upd, "$sort_order", existing.SortOrder);
            SqliteHelpers.Add(upd, "$updated_at", SqliteHelpers.FormatTimestamp(existing.UpdatedAt));
            await upd.ExecuteNonQueryAsync(ct);
        }

        foreach (var (pageId, slug) in newSlugs)
        {
            await using var upd = conn.CreateCommand();
            upd.Transaction = tx;
            upd.CommandText = "UPDATE page SET book_id = $book_id, slug = $slug WHERE id = $id";
            SqliteHelpers.Add(upd, "$id", pageId);
            SqliteHelpers.Add(upd, "$book_id", dest.Id);
            SqliteHelpers.Add(upd, "$slug", slug);
            await upd.ExecuteNonQueryAsync(ct);
        }

        if (newSlugs.Count > 0)
        {
            await using var upd = conn.CreateCommand();
            upd.Transaction = tx;
            var names = newSlugs.Select((_, i) => $"$p{i}").ToArray();
            upd.CommandText =
                $"UPDATE diagram SET book_id = $book_id WHERE page_id IN ({string.Join(", ", names)})";
            SqliteHelpers.Add(upd, "$book_id", dest.Id);
            for (var i = 0; i < newSlugs.Count; i++)
                SqliteHelpers.Add(upd, names[i], newSlugs[i].Id);
            await upd.ExecuteNonQueryAsync(ct);
        }

        await tx.CommitAsync(ct);

        // Same pattern as moving a book between shelves: flip ownership first,
        // then relocate bodies. Each content_ref is self-describing, so a
        // partial run is readable and the next move resumes it.
        if (!string.Equals(sourceProvider, destProvider, StringComparison.Ordinal)
            && newSlugs.Count > 0)
        {
            await mover.MovePageSetContentAsync(
                newSlugs.Select(p => p.Id).ToList(), destProvider, ct);
        }
    }

    private static async Task<int> NextChapterSortOrderAsync(
        SqliteConnection conn, string bookId, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM chapter WHERE book_id = $book_id";
        SqliteHelpers.Add(cmd, "$book_id", bookId);
        var value = await cmd.ExecuteScalarAsync(ct);
        return Convert.ToInt32(value ?? 0, System.Globalization.CultureInfo.InvariantCulture);
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
        return await ReadResolvedPageAsync(cmd, ct);
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
        return await ReadResolvedPageAsync(cmd, ct);
    }

    /// <summary>
    /// Execute a <see cref="PageSelect"/>-shaped single-row query and hand back
    /// the DTO with its body resolved — fetched from the row's storage provider
    /// when offloaded. The provider fetch happens after the reader is closed.
    /// </summary>
    private async Task<PageDto?> ReadResolvedPageAsync(SqliteCommand cmd, CancellationToken ct)
    {
        PageDto? dto = null;
        string? contentRef = null;
        await using (var reader = await cmd.ExecuteReaderAsync(ct))
        {
            if (await reader.ReadAsync(ct))
            {
                dto = ReadPageDto(reader);
                contentRef = SqliteHelpers.GetNullableString(reader, 16);
            }
        }

        if (dto is null || contentRef is null) return dto;
        return dto with { Content = await resolver.LoadAsync(dto.Content, contentRef, ct) };
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

        // Content placement is decided — and any provider upload done — before
        // the transaction opens, so a slow provider never holds the write lock.
        var body = page.Content;
        var target = await ContentResolver.ProviderIdForBookAsync(conn, book.Id, ct);
        var pageCell = await resolver.SaveAsync(body, target, ContentRef.PageKey(page.Id), null, ct);
        page.Content = pageCell.InlineValue;
        page.ContentRef = pageCell.ContentRef;
        page.ContentSize = pageCell.ContentSize;
        // A page cell that fell back inline means the provider is unreachable —
        // don't attempt a second doomed upload for the log entry.
        var revisionId = SqliteHelpers.NewId();
        var revisionCell = pageCell.ContentRef is null
            ? new ContentCell(body, null, null)
            : await resolver.SaveAsync(body, target, ContentRef.RevisionKey(revisionId), null, ct);

        // Page and its first log entry in one transaction: a page whose history
        // does not start at its own creation is a history with a hole in it.
        await using (var tx = (SqliteTransaction)await conn.BeginTransactionAsync(ct))
        {
            await InsertPageAsync(conn, page, tx, ct);
            await InsertRevisionAsync(conn, tx, page, PageChangeKinds.Created, actor, now, revisionId, revisionCell, ct);
            await tx.CommitAsync(ct);
        }

        var dto = ToDto(page, await OwnerNameAsync(conn, page.OwnerId, ct), actor.Id, actor.Name);
        return dto with { Content = body };
    }

    public async Task<PageDto?> UpdatePageAsync(string id, UpdatePageRequest request, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var existing = await SelectPageAsync(conn, id, ct);
        if (existing is null) return null;

        var actor = currentUser.Current;

        // Tracking settings belong to the page's owner (or an admin) — an editor
        // saving content must not be able to switch a page's version-keeping off
        // on the way. Null means untouched, so callers that don't know about the
        // fields (upsert, publish, older clients) sail through; only an actual
        // *change* is gated.
        if (request.MaxRevisions is < 0)
            throw new ArgumentException("maxRevisions must be 0 (unlimited) or a positive number.");
        var wantsTrackingChange =
            (request.TrackChanges is bool tc && tc != existing.TrackChanges)
            || (request.MaxRevisions is int mr && mr != existing.MaxRevisions);
        if (wantsTrackingChange)
        {
            var isOwner = actor.Id is not null && actor.Id == existing.OwnerId;
            if (!isOwner && !actor.IsAdmin)
                throw new UnauthorizedAccessException(
                    "Only the page's owner or an admin can change its tracking settings.");
        }

        var sourceProvider = await ContentResolver.ProviderIdForBookAsync(conn, existing.BookId, ct);
        var oldPageRef = existing.ContentRef;
        var body = request.Content ?? await resolver.LoadAsync(existing.Content, existing.ContentRef, ct);

        existing.Title = request.Title.Trim();
        if (!string.IsNullOrWhiteSpace(request.Slug))
            existing.Slug = SlugHelper.Slugify(request.Slug);
        if (request.ChapterId is not null)
            existing.ChapterId = string.IsNullOrWhiteSpace(request.ChapterId) ? null : request.ChapterId.Trim();
        if (request.SortOrder is int order)
            existing.SortOrder = order;
        if (request.OwnerId is not null)
            existing.OwnerId = NormalizeOwnerId(request.OwnerId);
        if (request.TrackChanges is bool trackChanges)
            existing.TrackChanges = trackChanges;
        if (request.MaxRevisions is int maxRevisions)
            existing.MaxRevisions = maxRevisions;

        var destBookId = string.IsNullOrWhiteSpace(request.BookId) ? null : request.BookId.Trim();
        var moving = destBookId is not null
            && !string.Equals(destBookId, existing.BookId, StringComparison.Ordinal);
        if (moving)
        {
            var dest = await SelectBookAsync(conn, destBookId!, ct)
                ?? throw new KeyNotFoundException($"Book '{destBookId}' was not found.");
            // A folder from the old book would dangle; omitted chapterId means root.
            if (request.ChapterId is null)
                existing.ChapterId = null;
            if (existing.ChapterId is not null)
            {
                var folder = await SelectChapterAsync(conn, existing.ChapterId, ct);
                if (folder is null
                    || !string.Equals(folder.BookId, dest.Id, StringComparison.Ordinal))
                    throw new ArgumentException(
                        "Folder does not belong to the destination book.", nameof(request.ChapterId));
            }

            existing.Slug = await UniquePageSlugAsync(conn, dest.Id, existing.Slug, ct);
            existing.BookId = dest.Id;
        }

        existing.UpdatedAt = DateTimeOffset.UtcNow;

        // Content placement is decided — and any provider I/O done — before the
        // transaction opens, so a slow provider never holds the write lock. A
        // metadata-only save of an offloaded page must fetch the body: the log
        // entry below records the full state, not just what changed. After a
        // book move this is the destination's provider, so the live body follows.
        var target = await ContentResolver.ProviderIdForBookAsync(conn, existing.BookId, ct);

        var pageCell = await resolver.SaveAsync(body, target, ContentRef.PageKey(existing.Id), oldPageRef, ct);
        existing.Content = pageCell.InlineValue;
        existing.ContentRef = pageCell.ContentRef;
        existing.ContentSize = pageCell.ContentSize;

        // Fold this save into the newest log entry when it is the same author
        // still in the same sitting (see RevisionCoalesceWindow) — decided here,
        // outside the transaction, because the coalesced entry's body may need a
        // provider upload of its own.
        var newest = await SelectNewestRevisionAsync(conn, existing.Id, ct);
        var coalesce = newest is not null
            && newest.ChangeKind == PageChangeKinds.Updated
            && string.Equals(newest.ChangedBy, actor.Id, StringComparison.Ordinal)
            && newest.CreatedAt >= existing.UpdatedAt - RevisionCoalesceWindow;
        // Version counts sittings, not auto-saves: fold this write into the
        // current sitting without bumping, so typing does not run the number up.
        if (!coalesce)
            existing.Version += 1;
        var revisionId = coalesce ? newest!.Id : SqliteHelpers.NewId();
        var oldRevisionRef = coalesce ? newest!.ContentRef : null;
        var revisionCell = pageCell.ContentRef is null
            ? new ContentCell(body, null, null)
            : await resolver.SaveAsync(body, target, ContentRef.RevisionKey(revisionId), oldRevisionRef, ct);

        IReadOnlyList<string> prunedRefs;
        await using (var tx = (SqliteTransaction)await conn.BeginTransactionAsync(ct))
        {
            await using (var cmd = conn.CreateCommand())
            {
                cmd.Transaction = tx;
                cmd.CommandText = """
                    UPDATE page SET book_id = $book_id, title = $title, slug = $slug, content = $content,
                      content_ref = $content_ref, content_size = $content_size, chapter_id = $chapter_id,
                      sort_order = $sort_order, version = $version, owner_id = $owner_id,
                      track_changes = $track_changes, max_revisions = $max_revisions, updated_at = $updated_at
                    WHERE id = $id
                    """;
                SqliteHelpers.Add(cmd, "$id", existing.Id);
                SqliteHelpers.Add(cmd, "$book_id", existing.BookId);
                SqliteHelpers.Add(cmd, "$title", existing.Title);
                SqliteHelpers.Add(cmd, "$slug", existing.Slug);
                SqliteHelpers.Add(cmd, "$content", existing.Content);
                SqliteHelpers.Add(cmd, "$content_ref", existing.ContentRef);
                SqliteHelpers.Add(cmd, "$content_size", existing.ContentSize);
                SqliteHelpers.Add(cmd, "$chapter_id", existing.ChapterId);
                SqliteHelpers.Add(cmd, "$sort_order", existing.SortOrder);
                SqliteHelpers.Add(cmd, "$version", existing.Version);
                SqliteHelpers.Add(cmd, "$owner_id", existing.OwnerId);
                SqliteHelpers.Add(cmd, "$track_changes", existing.TrackChanges ? 1 : 0);
                SqliteHelpers.Add(cmd, "$max_revisions", existing.MaxRevisions);
                SqliteHelpers.Add(cmd, "$updated_at", SqliteHelpers.FormatTimestamp(existing.UpdatedAt));
                await cmd.ExecuteNonQueryAsync(ct);
            }

            if (moving)
            {
                await using var diag = conn.CreateCommand();
                diag.Transaction = tx;
                diag.CommandText = "UPDATE diagram SET book_id = $book_id WHERE page_id = $id";
                SqliteHelpers.Add(diag, "$book_id", existing.BookId);
                SqliteHelpers.Add(diag, "$id", existing.Id);
                await diag.ExecuteNonQueryAsync(ct);
            }

            // Logged *after* the write and holding the new state, so the newest
            // entry always mirrors the live page and reading the log needs no
            // off-by-one.
            if (coalesce)
            {
                await using var update = conn.CreateCommand();
                update.Transaction = tx;
                update.CommandText = """
                    UPDATE page_revision
                    SET version = $version, title = $title, content = $content,
                        content_ref = $content_ref, content_size = $content_size,
                        changed_by_name = $changed_by_name, created_at = $created_at
                    WHERE id = $id
                    """;
                SqliteHelpers.Add(update, "$id", revisionId);
                SqliteHelpers.Add(update, "$version", existing.Version);
                SqliteHelpers.Add(update, "$title", existing.Title);
                SqliteHelpers.Add(update, "$content", revisionCell.InlineValue);
                SqliteHelpers.Add(update, "$content_ref", revisionCell.ContentRef);
                SqliteHelpers.Add(update, "$content_size", revisionCell.ContentSize);
                SqliteHelpers.Add(update, "$changed_by_name", actor.Name);
                SqliteHelpers.Add(update, "$created_at", SqliteHelpers.FormatTimestamp(existing.UpdatedAt));
                await update.ExecuteNonQueryAsync(ct);
            }
            else
            {
                await InsertRevisionAsync(
                    conn, tx, existing, PageChangeKinds.Updated, actor, existing.UpdatedAt, revisionId, revisionCell, ct);
            }

            prunedRefs = await PruneRevisionsAsync(conn, tx, existing, ct);
            await tx.CommitAsync(ct);
        }

        // Cloud cleanup strictly after the commit: rows must never point at
        // objects a rolled-back write already deleted. All best-effort.
        await resolver.CleanupReplacedAsync(oldPageRef, pageCell.ContentRef, ct);
        if (coalesce)
            await resolver.CleanupReplacedAsync(oldRevisionRef, revisionCell.ContentRef, ct);
        await resolver.DeleteAllAsync(prunedRefs, ct);

        // Live body already followed via SaveAsync above. Older revisions and
        // page-linked diagrams still sit on the source provider until this runs.
        if (moving && !string.Equals(sourceProvider, target, StringComparison.Ordinal))
            await mover.MovePageSetContentAsync([existing.Id], target, ct);

        var dto = ToDto(existing, await OwnerNameAsync(conn, existing.OwnerId, ct), actor.Id, actor.Name);
        return dto with { Content = body };
    }

    public async Task<bool> DeletePageAsync(string id, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var existing = await SelectPageAsync(conn, id, ct);
        if (existing is null) return false;

        var cloudRefs = new List<string>();
        if (existing.ContentRef is not null) cloudRefs.Add(existing.ContentRef);
        await CollectRefsAsync(conn, cloudRefs,
            "SELECT content_ref FROM page_revision WHERE page_id = $id AND content_ref IS NOT NULL",
            ("$id", id), ct);

        await using (var tx = (SqliteTransaction)await conn.BeginTransactionAsync(ct))
        {
            await ExecAsync(conn, tx, "DELETE FROM page_revision WHERE page_id = $id", ("$id", id), ct);
            await ExecAsync(conn, tx, "DELETE FROM page WHERE id = $id", ("$id", id), ct);
            await tx.CommitAsync(ct);
        }

        await resolver.DeleteAllAsync(cloudRefs, ct);
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

        return new PageHistoryDto(
            page.Id, page.Title, page.Version, page.TrackChanges, page.MaxRevisions, entries);
    }

    public async Task<PageRevisionDto?> GetPageRevisionAsync(
        string pageId,
        string revisionId,
        CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var page = await SelectPageAsync(conn, pageId, ct);
        // Old copies are served only while the owner has tracking switched on —
        // the rows may exist either way (they are also the change log), but
        // exposing their content is exactly what the toggle grants.
        if (page is null || !page.TrackChanges) return null;

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT id, version, title, content, changed_by, changed_by_name, change_kind, created_at, content_ref
            FROM page_revision
            WHERE id = $id AND page_id = $page_id
            LIMIT 1
            """;
        SqliteHelpers.Add(cmd, "$id", revisionId);
        SqliteHelpers.Add(cmd, "$page_id", page.Id);

        PageRevisionDto? dto = null;
        string? contentRef = null;
        await using (var reader = await cmd.ExecuteReaderAsync(ct))
        {
            if (await reader.ReadAsync(ct))
            {
                var version = reader.GetInt32(1);
                dto = new PageRevisionDto(
                    Id: reader.GetString(0),
                    PageId: page.Id,
                    Version: version,
                    Title: reader.GetString(2),
                    Content: reader.GetString(3),
                    ChangedById: SqliteHelpers.GetNullableString(reader, 4),
                    ChangedByName: SqliteHelpers.GetNullableString(reader, 5),
                    ChangeKind: reader.IsDBNull(6) ? PageChangeKinds.Updated : reader.GetString(6),
                    ChangedAt: Coalesce(SqliteHelpers.ReadTimestamp(reader, 7)),
                    IsCurrent: version == page.Version);
                contentRef = SqliteHelpers.GetNullableString(reader, 8);
            }
        }

        if (dto is null || contentRef is null) return dto;
        return dto with { Content = await resolver.LoadAsync(dto.Content, contentRef, ct) };
    }

    /// <summary>
    /// Enforce the page's copy cap: with tracking on and a limit set, only the
    /// newest <see cref="Page.MaxRevisions"/> rows survive a save (the newest row
    /// mirrors the live page, so a limit of 1 keeps just that). With tracking off
    /// or the limit at 0 the whole log is kept, exactly as before the feature.
    /// </summary>
    private static async Task<IReadOnlyList<string>> PruneRevisionsAsync(
        SqliteConnection conn,
        SqliteTransaction? tx,
        Page page,
        CancellationToken ct)
    {
        if (!page.TrackChanges || page.MaxRevisions <= 0) return [];

        // The doomed rows' cloud objects are the caller's to clean up after the
        // commit, so their refs are collected before the delete removes them.
        var refs = new List<string>();
        await using (var collect = conn.CreateCommand())
        {
            collect.Transaction = tx;
            collect.CommandText = """
                SELECT content_ref FROM page_revision
                WHERE page_id = $page_id AND content_ref IS NOT NULL AND id NOT IN (
                  SELECT id FROM page_revision
                  WHERE page_id = $page_id
                  ORDER BY version DESC, created_at DESC
                  LIMIT $keep)
                """;
            SqliteHelpers.Add(collect, "$page_id", page.Id);
            SqliteHelpers.Add(collect, "$keep", page.MaxRevisions);
            await using var reader = await collect.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
                refs.Add(reader.GetString(0));
        }

        await using var cmd = conn.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = """
            DELETE FROM page_revision
            WHERE page_id = $page_id AND id NOT IN (
              SELECT id FROM page_revision
              WHERE page_id = $page_id
              ORDER BY version DESC, created_at DESC
              LIMIT $keep)
            """;
        SqliteHelpers.Add(cmd, "$page_id", page.Id);
        SqliteHelpers.Add(cmd, "$keep", page.MaxRevisions);
        await cmd.ExecuteNonQueryAsync(ct);
        return refs;
    }

    /// <summary>
    /// Sliding idle window within which consecutive saves by the same author fold
    /// into the newest log entry instead of adding one each. Auto-save writes
    /// every couple of seconds while someone types, and without this every burst
    /// would become its own tracked copy. A fresh entry starts once the author
    /// has left the page alone this long — or someone else saves in between.
    /// </summary>
    private static readonly TimeSpan RevisionCoalesceWindow = TimeSpan.FromMinutes(5);

    /// <summary>
    /// The newest log entry, as far as coalescing cares: the row a same-sitting
    /// save would fold into. Only 'updated' rows by the same author within
    /// <see cref="RevisionCoalesceWindow"/> qualify — the 'created' entry stays
    /// the pristine first version, and a save after an idle gap (or by someone
    /// else) becomes a plain insert, which is what preserves the state the
    /// previous sitting left behind. The caller decides; this only reads.
    /// </summary>
    private sealed record NewestRevision(
        string Id, string ChangeKind, string? ChangedBy, DateTimeOffset CreatedAt, string? ContentRef);

    private static async Task<NewestRevision?> SelectNewestRevisionAsync(
        SqliteConnection conn, string pageId, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT id, change_kind, changed_by, created_at, content_ref
            FROM page_revision
            WHERE page_id = $page_id
            ORDER BY version DESC, created_at DESC
            LIMIT 1
            """;
        SqliteHelpers.Add(cmd, "$page_id", pageId);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) return null;
        return new NewestRevision(
            Id: reader.GetString(0),
            ChangeKind: reader.IsDBNull(1) ? PageChangeKinds.Updated : reader.GetString(1),
            ChangedBy: SqliteHelpers.GetNullableString(reader, 2),
            CreatedAt: SqliteHelpers.ReadTimestamp(reader, 3),
            ContentRef: SqliteHelpers.GetNullableString(reader, 4));
    }

    private static async Task InsertRevisionAsync(
        SqliteConnection conn,
        SqliteTransaction? tx,
        Page page,
        string changeKind,
        CurrentActor actor,
        DateTimeOffset changedAt,
        string revisionId,
        ContentCell cell,
        CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = """
            INSERT INTO page_revision
              (id, page_id, version, title, content, content_ref, content_size,
               changed_by, changed_by_name, change_kind, created_at)
            VALUES
              ($id, $page_id, $version, $title, $content, $content_ref, $content_size,
               $changed_by, $changed_by_name, $change_kind, $created_at)
            """;
        SqliteHelpers.Add(cmd, "$id", revisionId);
        SqliteHelpers.Add(cmd, "$page_id", page.Id);
        SqliteHelpers.Add(cmd, "$version", page.Version);
        SqliteHelpers.Add(cmd, "$title", page.Title);
        SqliteHelpers.Add(cmd, "$content", cell.InlineValue);
        SqliteHelpers.Add(cmd, "$content_ref", cell.ContentRef);
        SqliteHelpers.Add(cmd, "$content_size", cell.ContentSize);
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

    /// <summary>Name for a storage provider id — what the client shows instead of a raw id.</summary>
    private static async Task<string?> StorageProviderNameAsync(
        SqliteConnection conn, string? providerId, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(providerId)) return null;

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT name FROM storage_provider WHERE id = $id LIMIT 1";
        SqliteHelpers.Add(cmd, "$id", providerId);
        return await cmd.ExecuteScalarAsync(ct) as string;
    }

    /// <summary>Every cloud object a book's content rows point at, across all four tables.</summary>
    private static async Task<List<string>> CollectBookContentRefsAsync(
        SqliteConnection conn, string bookId, CancellationToken ct)
    {
        var refs = new List<string>();
        await CollectRefsAsync(conn, refs, """
            SELECT content_ref FROM page WHERE book_id = $id AND content_ref IS NOT NULL
            UNION ALL
            SELECT content_ref FROM page_revision
            WHERE page_id IN (SELECT id FROM page WHERE book_id = $id) AND content_ref IS NOT NULL
            UNION ALL
            SELECT content_ref FROM diagram WHERE book_id = $id AND content_ref IS NOT NULL
            UNION ALL
            SELECT content_ref FROM slide_deck WHERE book_id = $id AND content_ref IS NOT NULL
            """, ("$id", bookId), ct);
        return refs;
    }

    private static async Task CollectRefsAsync(
        SqliteConnection conn,
        List<string> refs,
        string sql,
        (string Name, object? Value) param,
        CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        SqliteHelpers.Add(cmd, param.Name, param.Value);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
            refs.Add(reader.GetString(0));
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
            INSERT INTO page (id, book_id, chapter_id, title, slug, content, content_ref, content_size,
              sort_order, version, owner_id, track_changes, max_revisions, created_at, updated_at)
            VALUES ($id, $book_id, $chapter_id, $title, $slug, $content, $content_ref, $content_size,
              $sort_order, $version, $owner_id, $track_changes, $max_revisions, $created_at, $updated_at)
            """;
        SqliteHelpers.Add(cmd, "$id", page.Id);
        SqliteHelpers.Add(cmd, "$book_id", page.BookId);
        SqliteHelpers.Add(cmd, "$chapter_id", page.ChapterId);
        SqliteHelpers.Add(cmd, "$title", page.Title);
        SqliteHelpers.Add(cmd, "$slug", page.Slug);
        SqliteHelpers.Add(cmd, "$content", page.Content);
        SqliteHelpers.Add(cmd, "$content_ref", page.ContentRef);
        SqliteHelpers.Add(cmd, "$content_size", page.ContentSize);
        SqliteHelpers.Add(cmd, "$sort_order", page.SortOrder);
        SqliteHelpers.Add(cmd, "$version", page.Version);
        SqliteHelpers.Add(cmd, "$owner_id", page.OwnerId);
        SqliteHelpers.Add(cmd, "$track_changes", page.TrackChanges ? 1 : 0);
        SqliteHelpers.Add(cmd, "$max_revisions", page.MaxRevisions);
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
            SELECT id, title, description, slug, sort_order, published, owner_id, storage_provider_id,
                   created_at, updated_at
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
            StorageProviderId = SqliteHelpers.GetNullableString(reader, 7),
            CreatedAt = SqliteHelpers.ReadTimestamp(reader, 8),
            UpdatedAt = SqliteHelpers.ReadTimestamp(reader, 9),
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
            SELECT id, book_id, chapter_id, title, slug, content, sort_order, version, owner_id, created_at, updated_at,
                   track_changes, max_revisions, content_ref, content_size
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
        TrackChanges = ReadFlag(reader, 11),
        MaxRevisions = reader.GetInt32(12),
        ContentRef = SqliteHelpers.GetNullableString(reader, 13),
        ContentSize = reader.IsDBNull(14) ? null : reader.GetInt64(14),
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
        BookCount: reader.GetInt32(10),
        StorageProviderId: SqliteHelpers.GetNullableString(reader, 11),
        StorageProviderName: SqliteHelpers.GetNullableString(reader, 12));

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
        UpdatedByName: SqliteHelpers.GetNullableString(reader, 13),
        TrackChanges: ReadFlag(reader, 14),
        MaxRevisions: reader.GetInt32(15));

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

    private static ShelfDto ToDto(Shelf s, string? ownerName, int bookCount, string? storageProviderName = null) => new(
        Id: s.Id,
        Title: s.Title,
        Description: s.Description,
        Slug: s.Slug,
        SortOrder: s.SortOrder,
        Published: s.Published,
        OwnerId: s.OwnerId,
        OwnerName: ownerName,
        BookCount: bookCount,
        StorageProviderId: s.StorageProviderId,
        StorageProviderName: storageProviderName,
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
        TrackChanges: p.TrackChanges,
        MaxRevisions: p.MaxRevisions,
        CreatedAt: Coalesce(p.CreatedAt),
        UpdatedAt: Coalesce(p.UpdatedAt));
}

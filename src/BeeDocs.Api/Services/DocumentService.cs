using BeeDocs.Api.Models;
using Microsoft.Data.Sqlite;

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

public sealed class DocumentService(SqliteConnectionFactory db) : IDocumentService
{
    public async Task<IReadOnlyList<BookDto>> ListBooksAsync(CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT id, title, description, slug, sort_order, created_at, updated_at
            FROM book
            ORDER BY sort_order, title COLLATE NOCASE
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
        var book = await SelectBookAsync(conn, id, ct);
        return book is null ? null : ToDto(book);
    }

    public async Task<BookDto?> GetBookBySlugAsync(string slug, CancellationToken ct = default)
    {
        var want = SlugHelper.Slugify(slug);
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT id, title, description, slug, sort_order, created_at, updated_at
            FROM book WHERE lower(slug) = lower($slug) LIMIT 1
            """;
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

        var book = new Book
        {
            Id = SqliteHelpers.NewId(),
            Title = request.Title.Trim(),
            Description = request.Description?.Trim(),
            Slug = slug,
            SortOrder = 0,
            CreatedAt = now,
            UpdatedAt = now,
        };

        await InsertBookAsync(conn, book, ct);
        return ToDto(book);
    }

    public async Task<BookDto?> UpdateBookAsync(string id, UpdateBookRequest request, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var existing = await SelectBookAsync(conn, id, ct);
        if (existing is null) return null;

        existing.Title = request.Title.Trim();
        existing.Description = request.Description?.Trim();
        if (!string.IsNullOrWhiteSpace(request.Slug))
            existing.Slug = SlugHelper.Slugify(request.Slug);
        if (request.SortOrder is int order)
            existing.SortOrder = order;
        existing.UpdatedAt = DateTimeOffset.UtcNow;

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            UPDATE book SET title = $title, description = $description, slug = $slug,
              sort_order = $sort_order, updated_at = $updated_at
            WHERE id = $id
            """;
        SqliteHelpers.Add(cmd, "$id", existing.Id);
        SqliteHelpers.Add(cmd, "$title", existing.Title);
        SqliteHelpers.Add(cmd, "$description", existing.Description);
        SqliteHelpers.Add(cmd, "$slug", existing.Slug);
        SqliteHelpers.Add(cmd, "$sort_order", existing.SortOrder);
        SqliteHelpers.Add(cmd, "$updated_at", SqliteHelpers.FormatTimestamp(existing.UpdatedAt));
        await cmd.ExecuteNonQueryAsync(ct);
        return ToDto(existing);
    }

    public async Task<bool> DeleteBookAsync(string id, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var existing = await SelectBookAsync(conn, id, ct);
        if (existing is null) return false;

        // Cascade pages, chapters, diagrams and book-scoped shape collections.
        await using (var tx = (SqliteTransaction)await conn.BeginTransactionAsync(ct))
        {
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
                SortOrder: request.SortOrder ?? existing.SortOrder),
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
            SELECT id, book_id, chapter_id, title, slug, sort_order, version, updated_at
            FROM page WHERE book_id = $book_id
            ORDER BY sort_order, title COLLATE NOCASE
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
                UpdatedAt: Coalesce(SqliteHelpers.ReadTimestamp(reader, 7))));
        }

        return list;
    }

    public async Task<PageDto?> GetPageAsync(string id, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var page = await SelectPageAsync(conn, id, ct);
        return page is null ? null : ToDto(page);
    }

    public async Task<PageDto?> GetPageBySlugAsync(string bookId, string pageSlug, CancellationToken ct = default)
    {
        var wantSlug = SlugHelper.Slugify(pageSlug);
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT id, book_id, chapter_id, title, slug, content, sort_order, version, created_at, updated_at
            FROM page
            WHERE book_id = $book_id AND lower(slug) = lower($slug)
            LIMIT 1
            """;
        SqliteHelpers.Add(cmd, "$book_id", bookId);
        SqliteHelpers.Add(cmd, "$slug", wantSlug);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) return null;
        return ToDto(ReadPage(reader));
    }

    public async Task<PageDto> CreatePageAsync(string bookId, CreatePageRequest request, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var book = await SelectBookAsync(conn, bookId, ct)
            ?? throw new KeyNotFoundException($"Book '{bookId}' not found.");

        var now = DateTimeOffset.UtcNow;
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
            CreatedAt = now,
            UpdatedAt = now,
        };

        await InsertPageAsync(conn, page, ct);
        return ToDto(page);
    }

    public async Task<PageDto?> UpdatePageAsync(string id, UpdatePageRequest request, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var existing = await SelectPageAsync(conn, id, ct);
        if (existing is null) return null;

        await using var tx = (SqliteTransaction)await conn.BeginTransactionAsync(ct);

        await using (var rev = conn.CreateCommand())
        {
            rev.Transaction = tx;
            rev.CommandText = """
                INSERT INTO page_revision (id, page_id, version, title, content, created_at)
                VALUES ($id, $page_id, $version, $title, $content, $created_at)
                """;
            SqliteHelpers.Add(rev, "$id", SqliteHelpers.NewId());
            SqliteHelpers.Add(rev, "$page_id", existing.Id);
            SqliteHelpers.Add(rev, "$version", existing.Version);
            SqliteHelpers.Add(rev, "$title", existing.Title);
            SqliteHelpers.Add(rev, "$content", existing.Content);
            SqliteHelpers.Add(rev, "$created_at", SqliteHelpers.FormatTimestamp(DateTimeOffset.UtcNow));
            await rev.ExecuteNonQueryAsync(ct);
        }

        existing.Title = request.Title.Trim();
        if (!string.IsNullOrWhiteSpace(request.Slug))
            existing.Slug = SlugHelper.Slugify(request.Slug);
        if (request.Content is not null)
            existing.Content = request.Content;
        if (request.ChapterId is not null)
            existing.ChapterId = string.IsNullOrWhiteSpace(request.ChapterId) ? null : request.ChapterId.Trim();
        if (request.SortOrder is int order)
            existing.SortOrder = order;
        existing.Version += 1;
        existing.UpdatedAt = DateTimeOffset.UtcNow;

        await using (var cmd = conn.CreateCommand())
        {
            cmd.Transaction = tx;
            cmd.CommandText = """
                UPDATE page SET title = $title, slug = $slug, content = $content, chapter_id = $chapter_id,
                  sort_order = $sort_order, version = $version, updated_at = $updated_at
                WHERE id = $id
                """;
            SqliteHelpers.Add(cmd, "$id", existing.Id);
            SqliteHelpers.Add(cmd, "$title", existing.Title);
            SqliteHelpers.Add(cmd, "$slug", existing.Slug);
            SqliteHelpers.Add(cmd, "$content", existing.Content);
            SqliteHelpers.Add(cmd, "$chapter_id", existing.ChapterId);
            SqliteHelpers.Add(cmd, "$sort_order", existing.SortOrder);
            SqliteHelpers.Add(cmd, "$version", existing.Version);
            SqliteHelpers.Add(cmd, "$updated_at", SqliteHelpers.FormatTimestamp(existing.UpdatedAt));
            await cmd.ExecuteNonQueryAsync(ct);
        }

        await tx.CommitAsync(ct);
        return ToDto(existing);
    }

    public async Task<bool> DeletePageAsync(string id, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var existing = await SelectPageAsync(conn, id, ct);
        if (existing is null) return false;
        await ExecAsync(conn, null, "DELETE FROM page WHERE id = $id", ("$id", id), ct);
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

    private static async Task InsertBookAsync(SqliteConnection conn, Book book, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO book (id, title, description, slug, sort_order, created_at, updated_at)
            VALUES ($id, $title, $description, $slug, $sort_order, $created_at, $updated_at)
            """;
        SqliteHelpers.Add(cmd, "$id", book.Id);
        SqliteHelpers.Add(cmd, "$title", book.Title);
        SqliteHelpers.Add(cmd, "$description", book.Description);
        SqliteHelpers.Add(cmd, "$slug", book.Slug);
        SqliteHelpers.Add(cmd, "$sort_order", book.SortOrder);
        SqliteHelpers.Add(cmd, "$created_at", SqliteHelpers.FormatTimestamp(book.CreatedAt));
        SqliteHelpers.Add(cmd, "$updated_at", SqliteHelpers.FormatTimestamp(book.UpdatedAt));
        await cmd.ExecuteNonQueryAsync(ct);
    }

    private static async Task InsertPageAsync(SqliteConnection conn, Page page, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO page (id, book_id, chapter_id, title, slug, content, sort_order, version, created_at, updated_at)
            VALUES ($id, $book_id, $chapter_id, $title, $slug, $content, $sort_order, $version, $created_at, $updated_at)
            """;
        SqliteHelpers.Add(cmd, "$id", page.Id);
        SqliteHelpers.Add(cmd, "$book_id", page.BookId);
        SqliteHelpers.Add(cmd, "$chapter_id", page.ChapterId);
        SqliteHelpers.Add(cmd, "$title", page.Title);
        SqliteHelpers.Add(cmd, "$slug", page.Slug);
        SqliteHelpers.Add(cmd, "$content", page.Content);
        SqliteHelpers.Add(cmd, "$sort_order", page.SortOrder);
        SqliteHelpers.Add(cmd, "$version", page.Version);
        SqliteHelpers.Add(cmd, "$created_at", SqliteHelpers.FormatTimestamp(page.CreatedAt));
        SqliteHelpers.Add(cmd, "$updated_at", SqliteHelpers.FormatTimestamp(page.UpdatedAt));
        await cmd.ExecuteNonQueryAsync(ct);
    }

    private static async Task<Book?> SelectBookAsync(SqliteConnection conn, string id, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT id, title, description, slug, sort_order, created_at, updated_at
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
            CreatedAt = SqliteHelpers.ReadTimestamp(reader, 5),
            UpdatedAt = SqliteHelpers.ReadTimestamp(reader, 6),
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
            SELECT id, book_id, chapter_id, title, slug, content, sort_order, version, created_at, updated_at
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
        CreatedAt = SqliteHelpers.ReadTimestamp(reader, 8),
        UpdatedAt = SqliteHelpers.ReadTimestamp(reader, 9),
    };

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

    private static BookDto ReadBookDto(SqliteDataReader reader) => new(
        Id: reader.GetString(0),
        Title: reader.GetString(1),
        Description: SqliteHelpers.GetNullableString(reader, 2),
        Slug: reader.GetString(3),
        SortOrder: reader.GetInt32(4),
        CreatedAt: Coalesce(SqliteHelpers.ReadTimestamp(reader, 5)),
        UpdatedAt: Coalesce(SqliteHelpers.ReadTimestamp(reader, 6)));

    private static ChapterDto ReadChapterDto(SqliteDataReader reader) => new(
        Id: reader.GetString(0),
        BookId: reader.GetString(1),
        Title: reader.GetString(2),
        Slug: reader.GetString(3),
        SortOrder: reader.GetInt32(4),
        CreatedAt: Coalesce(SqliteHelpers.ReadTimestamp(reader, 5)),
        UpdatedAt: Coalesce(SqliteHelpers.ReadTimestamp(reader, 6)));

    private static BookDto ToDto(Book b) => new(
        Id: b.Id,
        Title: b.Title,
        Description: b.Description,
        Slug: b.Slug,
        SortOrder: b.SortOrder,
        CreatedAt: Coalesce(b.CreatedAt),
        UpdatedAt: Coalesce(b.UpdatedAt));

    private static ChapterDto ToDto(Chapter c) => new(
        Id: c.Id,
        BookId: c.BookId,
        Title: c.Title,
        Slug: c.Slug,
        SortOrder: c.SortOrder,
        CreatedAt: Coalesce(c.CreatedAt),
        UpdatedAt: Coalesce(c.UpdatedAt));

    private static PageDto ToDto(Page p) => new(
        Id: p.Id,
        BookId: p.BookId,
        ChapterId: p.ChapterId,
        Title: p.Title,
        Slug: p.Slug,
        Content: p.Content,
        SortOrder: p.SortOrder,
        Version: p.Version,
        CreatedAt: Coalesce(p.CreatedAt),
        UpdatedAt: Coalesce(p.UpdatedAt));
}

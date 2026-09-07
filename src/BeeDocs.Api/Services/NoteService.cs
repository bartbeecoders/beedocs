using System.Text.Json;
using BeeDocs.Api.Models;
using Microsoft.Data.Sqlite;

namespace BeeDocs.Api.Services;

public interface INoteService
{
    Task<IReadOnlyList<NoteSummaryDto>> ListByBookAsync(string bookId, CancellationToken ct = default);
    Task<NoteDto?> GetAsync(string id, CancellationToken ct = default);
    Task<NoteDto> CreateAsync(string bookId, CreateNoteRequest request, CancellationToken ct = default);
    Task<NoteDto?> UpdateAsync(string id, UpdateNoteRequest request, CancellationToken ct = default);
    Task<bool> DeleteAsync(string id, CancellationToken ct = default);
}

/// <summary>
/// OneNote-style notes: same storage shape as diagrams / decks / boards / plans.
/// The document is stored verbatim; the server reads only the block count here
/// and the block texts in <see cref="SearchText.FromNoteSource"/>.
/// </summary>
public sealed class NoteService(
    SqliteConnectionFactory db, ContentResolver resolver, ICurrentUserAccessor currentUser) : INoteService
{
    /// <summary>An empty page. The web editor owns the richer starter note.</summary>
    public static string DefaultSource { get; } =
        """{"version":1,"background":"plain","paper":"white","blocks":[]}""";

    public async Task<IReadOnlyList<NoteSummaryDto>> ListByBookAsync(string bookId, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        var actor = currentUser.Current;
        cmd.CommandText = $"""
            SELECT id, book_id, title, source, updated_at, block_count, owner_id, is_private
            FROM note WHERE book_id = $book_id{Privacy.DocumentSql("note", actor)}
            ORDER BY updated_at DESC, title COLLATE NOCASE
            """;
        SqliteHelpers.Add(cmd, "$book_id", bookId);
        Privacy.BindViewer(cmd, actor);
        var list = new List<NoteSummaryDto>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            list.Add(new NoteSummaryDto(
                Id: reader.GetString(0),
                BookId: reader.GetString(1),
                Title: reader.GetString(2),
                BlockCount: reader.IsDBNull(5)
                    ? CountBlocks(SqliteHelpers.GetNullableString(reader, 3))
                    : (int)reader.GetInt64(5),
                OwnerId: SqliteHelpers.GetNullableString(reader, 6),
                IsPrivate: Privacy.ReadFlag(reader, 7),
                UpdatedAt: SqliteHelpers.ReadTimestamp(reader, 4)));
        }
        return list;
    }

    public async Task<NoteDto?> GetAsync(string id, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var row = await SelectAsync(conn, id, ct);
        if (row is null) return null;
        if (!await Privacy.IsDocumentVisibleAsync(
                conn, currentUser.Current, row.IsPrivate, row.OwnerId, row.BookId, ct))
            return null;
        row.Source = await resolver.LoadAsync(row.Source, row.ContentRef, ct);
        return ToDto(row, await Privacy.OwnerNameAsync(conn, row.OwnerId, ct));
    }

    public async Task<NoteDto> CreateAsync(string bookId, CreateNoteRequest request, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        string? bookOwnerId;
        await using (var check = conn.CreateCommand())
        {
            check.CommandText = "SELECT owner_id FROM book WHERE id = $id LIMIT 1";
            SqliteHelpers.Add(check, "$id", bookId);
            await using var reader = await check.ExecuteReaderAsync(ct);
            if (!await reader.ReadAsync(ct))
                throw new KeyNotFoundException($"Book '{bookId}' not found.");
            bookOwnerId = SqliteHelpers.GetNullableString(reader, 0);
        }

        var now = DateTimeOffset.UtcNow;
        var actor = currentUser.Current;
        var body = string.IsNullOrWhiteSpace(request.Source) ? DefaultSource : request.Source;
        var note = new Note
        {
            Id = SqliteHelpers.NewId(),
            BookId = bookId,
            Title = request.Title.Trim(),
            BlockCount = CountBlocks(body),
            OwnerId = string.IsNullOrWhiteSpace(request.OwnerId) ? bookOwnerId ?? actor.Id : request.OwnerId.Trim(),
            IsPrivate = request.IsPrivate ?? false,
            CreatedAt = now,
            UpdatedAt = now,
        };
        Privacy.EnsurePrivateHasOwner(note.IsPrivate, note.OwnerId);

        // Provider I/O before any SQLite write, like every other domain save.
        var target = await ContentResolver.ProviderIdForBookAsync(conn, bookId, ct);
        var cell = await resolver.SaveAsync(body, target, ContentRef.NoteKey(note.Id), null, ct);
        note.Source = cell.InlineValue;
        note.ContentRef = cell.ContentRef;
        note.ContentSize = cell.ContentSize;

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO note (id, book_id, title, source, content_ref, content_size, block_count,
              owner_id, is_private, created_at, updated_at)
            VALUES ($id, $book_id, $title, $source, $content_ref, $content_size, $block_count,
              $owner_id, $is_private, $created_at, $updated_at)
            """;
        SqliteHelpers.Add(cmd, "$id", note.Id);
        SqliteHelpers.Add(cmd, "$book_id", note.BookId);
        SqliteHelpers.Add(cmd, "$title", note.Title);
        SqliteHelpers.Add(cmd, "$source", note.Source);
        SqliteHelpers.Add(cmd, "$content_ref", note.ContentRef);
        SqliteHelpers.Add(cmd, "$content_size", note.ContentSize);
        SqliteHelpers.Add(cmd, "$block_count", note.BlockCount);
        SqliteHelpers.Add(cmd, "$owner_id", note.OwnerId);
        SqliteHelpers.Add(cmd, "$is_private", note.IsPrivate ? 1 : 0);
        SqliteHelpers.Add(cmd, "$created_at", SqliteHelpers.FormatTimestamp(note.CreatedAt));
        SqliteHelpers.Add(cmd, "$updated_at", SqliteHelpers.FormatTimestamp(note.UpdatedAt));
        await cmd.ExecuteNonQueryAsync(ct);

        note.Source = body;
        return ToDto(note, await Privacy.OwnerNameAsync(conn, note.OwnerId, ct));
    }

    public async Task<NoteDto?> UpdateAsync(string id, UpdateNoteRequest request, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var existing = await SelectAsync(conn, id, ct);
        if (existing is null) return null;
        if (!await Privacy.IsDocumentVisibleAsync(
                conn, currentUser.Current, existing.IsPrivate, existing.OwnerId, existing.BookId, ct))
            return null;

        existing.Title = request.Title.Trim();
        (existing.OwnerId, existing.IsPrivate) = Privacy.Apply(
            currentUser.Current, existing.OwnerId, existing.IsPrivate, request.OwnerId, request.IsPrivate);
        existing.UpdatedAt = DateTimeOffset.UtcNow;

        var target = await ContentResolver.ProviderIdForBookAsync(conn, existing.BookId, ct);
        var oldRef = existing.ContentRef;
        var body = request.Source ?? await resolver.LoadAsync(existing.Source, existing.ContentRef, ct);
        existing.BlockCount = CountBlocks(body);
        var cell = await resolver.SaveAsync(body, target, ContentRef.NoteKey(existing.Id), oldRef, ct);
        existing.Source = cell.InlineValue;
        existing.ContentRef = cell.ContentRef;
        existing.ContentSize = cell.ContentSize;

        await using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = """
                UPDATE note SET title = $title, source = $source, content_ref = $content_ref,
                  content_size = $content_size, block_count = $block_count,
                  owner_id = $owner_id, is_private = $is_private, updated_at = $updated_at
                WHERE id = $id
                """;
            SqliteHelpers.Add(cmd, "$id", existing.Id);
            SqliteHelpers.Add(cmd, "$title", existing.Title);
            SqliteHelpers.Add(cmd, "$source", existing.Source);
            SqliteHelpers.Add(cmd, "$content_ref", existing.ContentRef);
            SqliteHelpers.Add(cmd, "$content_size", existing.ContentSize);
            SqliteHelpers.Add(cmd, "$block_count", existing.BlockCount);
            SqliteHelpers.Add(cmd, "$owner_id", existing.OwnerId);
            SqliteHelpers.Add(cmd, "$is_private", existing.IsPrivate ? 1 : 0);
            SqliteHelpers.Add(cmd, "$updated_at", SqliteHelpers.FormatTimestamp(existing.UpdatedAt));
            await cmd.ExecuteNonQueryAsync(ct);
        }

        await resolver.CleanupReplacedAsync(oldRef, cell.ContentRef, ct);
        existing.Source = body;
        return ToDto(existing, await Privacy.OwnerNameAsync(conn, existing.OwnerId, ct));
    }

    public async Task<bool> DeleteAsync(string id, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var existing = await SelectAsync(conn, id, ct);
        if (existing is null) return false;
        if (!await Privacy.IsDocumentVisibleAsync(
                conn, currentUser.Current, existing.IsPrivate, existing.OwnerId, existing.BookId, ct))
            return false;

        await using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = "DELETE FROM note WHERE id = $id";
            SqliteHelpers.Add(cmd, "$id", id);
            await cmd.ExecuteNonQueryAsync(ct);
        }

        await resolver.DeleteAsync(existing.ContentRef, ct);
        return true;
    }

    /// <summary>Blocks on the note. A document that fails to parse counts as none.</summary>
    internal static int CountBlocks(string? source)
    {
        if (string.IsNullOrWhiteSpace(source)) return 0;
        try
        {
            using var doc = JsonDocument.Parse(source);
            if (doc.RootElement.ValueKind != JsonValueKind.Object
                || !doc.RootElement.TryGetProperty("blocks", out var blocks)
                || blocks.ValueKind != JsonValueKind.Array)
            {
                return 0;
            }

            return blocks.GetArrayLength();
        }
        catch (JsonException)
        {
            return 0;
        }
    }

    private static async Task<Note?> SelectAsync(SqliteConnection conn, string id, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT id, book_id, title, source, created_at, updated_at, content_ref, content_size, block_count,
                   owner_id, is_private
            FROM note WHERE id = $id LIMIT 1
            """;
        SqliteHelpers.Add(cmd, "$id", id);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) return null;
        return new Note
        {
            Id = reader.GetString(0),
            BookId = reader.GetString(1),
            Title = reader.GetString(2),
            Source = reader.GetString(3),
            CreatedAt = SqliteHelpers.ReadTimestamp(reader, 4),
            UpdatedAt = SqliteHelpers.ReadTimestamp(reader, 5),
            ContentRef = SqliteHelpers.GetNullableString(reader, 6),
            ContentSize = reader.IsDBNull(7) ? null : reader.GetInt64(7),
            BlockCount = reader.IsDBNull(8) ? null : (int)reader.GetInt64(8),
            OwnerId = SqliteHelpers.GetNullableString(reader, 9),
            IsPrivate = Privacy.ReadFlag(reader, 10),
        };
    }

    private static NoteDto ToDto(Note n, string? ownerName) => new(
        Id: n.Id,
        BookId: n.BookId,
        Title: n.Title,
        Source: n.Source,
        OwnerId: n.OwnerId,
        OwnerName: ownerName,
        IsPrivate: n.IsPrivate,
        CreatedAt: n.CreatedAt,
        UpdatedAt: n.UpdatedAt);
}

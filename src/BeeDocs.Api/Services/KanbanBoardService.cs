using System.Text.Json;
using BeeDocs.Api.Models;
using Microsoft.Data.Sqlite;

namespace BeeDocs.Api.Services;

public interface IKanbanBoardService
{
    Task<IReadOnlyList<KanbanBoardSummaryDto>> ListByBookAsync(string bookId, CancellationToken ct = default);
    Task<KanbanBoardDto?> GetAsync(string id, CancellationToken ct = default);
    Task<KanbanBoardDto> CreateAsync(string bookId, CreateKanbanBoardRequest request, CancellationToken ct = default);
    Task<KanbanBoardDto?> UpdateAsync(string id, UpdateKanbanBoardRequest request, CancellationToken ct = default);
    Task<bool> DeleteAsync(string id, CancellationToken ct = default);
}

public sealed class KanbanBoardService(
    SqliteConnectionFactory db, ContentResolver resolver, ICurrentUserAccessor currentUser) : IKanbanBoardService
{
    /// <summary>Three empty columns. The web editor owns the richer starter boards.</summary>
    public static string DefaultSource { get; } =
        """{"version":1,"columns":[{"id":"col-todo","title":"To do","wip":null,"cards":[]},{"id":"col-doing","title":"In progress","wip":null,"cards":[]},{"id":"col-done","title":"Done","wip":null,"cards":[]}]}""";

    public async Task<IReadOnlyList<KanbanBoardSummaryDto>> ListByBookAsync(string bookId, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        var actor = currentUser.Current;
        cmd.CommandText = $"""
            SELECT id, book_id, title, source, updated_at, card_count, owner_id, is_private
            FROM kanban_board WHERE book_id = $book_id{Privacy.DocumentSql("kanban_board", actor)}
            ORDER BY updated_at DESC, title COLLATE NOCASE
            """;
        SqliteHelpers.Add(cmd, "$book_id", bookId);
        Privacy.BindViewer(cmd, actor);
        var list = new List<KanbanBoardSummaryDto>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            list.Add(new KanbanBoardSummaryDto(
                Id: reader.GetString(0),
                BookId: reader.GetString(1),
                Title: reader.GetString(2),
                CardCount: reader.IsDBNull(5)
                    ? CountCards(SqliteHelpers.GetNullableString(reader, 3))
                    : (int)reader.GetInt64(5),
                OwnerId: SqliteHelpers.GetNullableString(reader, 6),
                IsPrivate: Privacy.ReadFlag(reader, 7),
                UpdatedAt: SqliteHelpers.ReadTimestamp(reader, 4)));
        }
        return list;
    }

    public async Task<KanbanBoardDto?> GetAsync(string id, CancellationToken ct = default)
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

    public async Task<KanbanBoardDto> CreateAsync(string bookId, CreateKanbanBoardRequest request, CancellationToken ct = default)
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
        var board = new KanbanBoard
        {
            Id = SqliteHelpers.NewId(),
            BookId = bookId,
            Title = request.Title.Trim(),
            CardCount = CountCards(body),
            OwnerId = string.IsNullOrWhiteSpace(request.OwnerId) ? bookOwnerId ?? actor.Id : request.OwnerId.Trim(),
            IsPrivate = request.IsPrivate ?? false,
            CreatedAt = now,
            UpdatedAt = now,
        };
        Privacy.EnsurePrivateHasOwner(board.IsPrivate, board.OwnerId);

        var target = await ContentResolver.ProviderIdForBookAsync(conn, bookId, ct);
        var cell = await resolver.SaveAsync(body, target, ContentRef.KanbanKey(board.Id), null, ct);
        board.Source = cell.InlineValue;
        board.ContentRef = cell.ContentRef;
        board.ContentSize = cell.ContentSize;

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO kanban_board (id, book_id, title, source, content_ref, content_size, card_count,
              owner_id, is_private, created_at, updated_at)
            VALUES ($id, $book_id, $title, $source, $content_ref, $content_size, $card_count,
              $owner_id, $is_private, $created_at, $updated_at)
            """;
        SqliteHelpers.Add(cmd, "$id", board.Id);
        SqliteHelpers.Add(cmd, "$book_id", board.BookId);
        SqliteHelpers.Add(cmd, "$title", board.Title);
        SqliteHelpers.Add(cmd, "$source", board.Source);
        SqliteHelpers.Add(cmd, "$content_ref", board.ContentRef);
        SqliteHelpers.Add(cmd, "$content_size", board.ContentSize);
        SqliteHelpers.Add(cmd, "$card_count", board.CardCount);
        SqliteHelpers.Add(cmd, "$owner_id", board.OwnerId);
        SqliteHelpers.Add(cmd, "$is_private", board.IsPrivate ? 1 : 0);
        SqliteHelpers.Add(cmd, "$created_at", SqliteHelpers.FormatTimestamp(board.CreatedAt));
        SqliteHelpers.Add(cmd, "$updated_at", SqliteHelpers.FormatTimestamp(board.UpdatedAt));
        await cmd.ExecuteNonQueryAsync(ct);

        board.Source = body;
        return ToDto(board, await Privacy.OwnerNameAsync(conn, board.OwnerId, ct));
    }

    public async Task<KanbanBoardDto?> UpdateAsync(string id, UpdateKanbanBoardRequest request, CancellationToken ct = default)
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
        existing.CardCount = CountCards(body);
        var cell = await resolver.SaveAsync(body, target, ContentRef.KanbanKey(existing.Id), oldRef, ct);
        existing.Source = cell.InlineValue;
        existing.ContentRef = cell.ContentRef;
        existing.ContentSize = cell.ContentSize;

        await using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = """
                UPDATE kanban_board SET title = $title, source = $source, content_ref = $content_ref,
                  content_size = $content_size, card_count = $card_count,
                  owner_id = $owner_id, is_private = $is_private, updated_at = $updated_at
                WHERE id = $id
                """;
            SqliteHelpers.Add(cmd, "$id", existing.Id);
            SqliteHelpers.Add(cmd, "$title", existing.Title);
            SqliteHelpers.Add(cmd, "$source", existing.Source);
            SqliteHelpers.Add(cmd, "$content_ref", existing.ContentRef);
            SqliteHelpers.Add(cmd, "$content_size", existing.ContentSize);
            SqliteHelpers.Add(cmd, "$card_count", existing.CardCount);
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
            cmd.CommandText = "DELETE FROM kanban_board WHERE id = $id";
            SqliteHelpers.Add(cmd, "$id", id);
            await cmd.ExecuteNonQueryAsync(ct);
        }

        await resolver.DeleteAsync(existing.ContentRef, ct);
        return true;
    }

    /// <summary>Cards across every column. A board that fails to parse counts as none.</summary>
    internal static int CountCards(string? source)
    {
        if (string.IsNullOrWhiteSpace(source)) return 0;
        try
        {
            using var doc = JsonDocument.Parse(source);
            if (doc.RootElement.ValueKind != JsonValueKind.Object
                || !doc.RootElement.TryGetProperty("columns", out var columns)
                || columns.ValueKind != JsonValueKind.Array)
            {
                return 0;
            }

            var n = 0;
            foreach (var col in columns.EnumerateArray())
            {
                if (col.ValueKind == JsonValueKind.Object
                    && col.TryGetProperty("cards", out var cards)
                    && cards.ValueKind == JsonValueKind.Array)
                {
                    n += cards.GetArrayLength();
                }
            }
            return n;
        }
        catch (JsonException)
        {
            return 0;
        }
    }

    private static async Task<KanbanBoard?> SelectAsync(SqliteConnection conn, string id, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT id, book_id, title, source, created_at, updated_at, content_ref, content_size, card_count,
                   owner_id, is_private
            FROM kanban_board WHERE id = $id LIMIT 1
            """;
        SqliteHelpers.Add(cmd, "$id", id);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) return null;
        return new KanbanBoard
        {
            Id = reader.GetString(0),
            BookId = reader.GetString(1),
            Title = reader.GetString(2),
            Source = reader.GetString(3),
            CreatedAt = SqliteHelpers.ReadTimestamp(reader, 4),
            UpdatedAt = SqliteHelpers.ReadTimestamp(reader, 5),
            ContentRef = SqliteHelpers.GetNullableString(reader, 6),
            ContentSize = reader.IsDBNull(7) ? null : reader.GetInt64(7),
            CardCount = reader.IsDBNull(8) ? null : (int)reader.GetInt64(8),
            OwnerId = SqliteHelpers.GetNullableString(reader, 9),
            IsPrivate = Privacy.ReadFlag(reader, 10),
        };
    }

    private static KanbanBoardDto ToDto(KanbanBoard d, string? ownerName) => new(
        Id: d.Id,
        BookId: d.BookId,
        Title: d.Title,
        Source: d.Source,
        OwnerId: d.OwnerId,
        OwnerName: ownerName,
        IsPrivate: d.IsPrivate,
        CreatedAt: d.CreatedAt,
        UpdatedAt: d.UpdatedAt);
}

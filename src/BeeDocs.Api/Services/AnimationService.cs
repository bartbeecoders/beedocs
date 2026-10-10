using System.Text.Json;
using BeeDocs.Api.Models;
using Microsoft.Data.Sqlite;

namespace BeeDocs.Api.Services;

public interface IAnimationService
{
    Task<IReadOnlyList<AnimationSummaryDto>> ListByBookAsync(string bookId, CancellationToken ct = default);
    Task<AnimationDto?> GetAsync(string id, CancellationToken ct = default);
    Task<AnimationDto> CreateAsync(string bookId, CreateAnimationRequest request, CancellationToken ct = default);
    Task<AnimationDto?> UpdateAsync(string id, UpdateAnimationRequest request, CancellationToken ct = default);
    Task<bool> DeleteAsync(string id, CancellationToken ct = default);
}

public sealed class AnimationService(
    SqliteConnectionFactory db, ContentResolver resolver, ICurrentUserAccessor currentUser) : IAnimationService
{
    /// <summary>One empty scene on a 1280×720 stage. The web editor owns the richer starter animation.</summary>
    public static string DefaultSource { get; } =
        """{"version":1,"width":1280,"height":720,"fps":30,"background":"#0f172a","accent":"#f59e0b","captions":true,"scenes":[{"id":"scene-1","title":"Scene 1","duration":4,"elements":[]}]}""";

    public async Task<IReadOnlyList<AnimationSummaryDto>> ListByBookAsync(string bookId, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        var actor = currentUser.Current;
        cmd.CommandText = $"""
            SELECT id, book_id, title, source, updated_at, scene_count, owner_id, is_private
            FROM animation WHERE book_id = $book_id{Privacy.DocumentSql("animation", actor)}
            ORDER BY updated_at DESC, title COLLATE NOCASE
            """;
        SqliteHelpers.Add(cmd, "$book_id", bookId);
        Privacy.BindViewer(cmd, actor);
        var list = new List<AnimationSummaryDto>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            list.Add(new AnimationSummaryDto(
                Id: reader.GetString(0),
                BookId: reader.GetString(1),
                Title: reader.GetString(2),
                SceneCount: reader.IsDBNull(5)
                    ? CountScenes(SqliteHelpers.GetNullableString(reader, 3))
                    : (int)reader.GetInt64(5),
                OwnerId: SqliteHelpers.GetNullableString(reader, 6),
                IsPrivate: Privacy.ReadFlag(reader, 7),
                UpdatedAt: SqliteHelpers.ReadTimestamp(reader, 4)));
        }
        return list;
    }

    public async Task<AnimationDto?> GetAsync(string id, CancellationToken ct = default)
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

    public async Task<AnimationDto> CreateAsync(string bookId, CreateAnimationRequest request, CancellationToken ct = default)
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
        var animation = new Animation
        {
            Id = SqliteHelpers.NewId(),
            BookId = bookId,
            Title = request.Title.Trim(),
            SceneCount = CountScenes(body),
            OwnerId = string.IsNullOrWhiteSpace(request.OwnerId) ? bookOwnerId ?? actor.Id : request.OwnerId.Trim(),
            IsPrivate = request.IsPrivate ?? false,
            CreatedAt = now,
            UpdatedAt = now,
        };
        Privacy.EnsurePrivateHasOwner(animation.IsPrivate, animation.OwnerId);

        var target = await ContentResolver.ProviderIdForBookAsync(conn, bookId, ct);
        var cell = await resolver.SaveAsync(body, target, ContentRef.AnimationKey(animation.Id), null, ct);
        animation.Source = cell.InlineValue;
        animation.ContentRef = cell.ContentRef;
        animation.ContentSize = cell.ContentSize;

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO animation (id, book_id, title, source, content_ref, content_size, scene_count,
              owner_id, is_private, created_at, updated_at)
            VALUES ($id, $book_id, $title, $source, $content_ref, $content_size, $scene_count,
              $owner_id, $is_private, $created_at, $updated_at)
            """;
        SqliteHelpers.Add(cmd, "$id", animation.Id);
        SqliteHelpers.Add(cmd, "$book_id", animation.BookId);
        SqliteHelpers.Add(cmd, "$title", animation.Title);
        SqliteHelpers.Add(cmd, "$source", animation.Source);
        SqliteHelpers.Add(cmd, "$content_ref", animation.ContentRef);
        SqliteHelpers.Add(cmd, "$content_size", animation.ContentSize);
        SqliteHelpers.Add(cmd, "$scene_count", animation.SceneCount);
        SqliteHelpers.Add(cmd, "$owner_id", animation.OwnerId);
        SqliteHelpers.Add(cmd, "$is_private", animation.IsPrivate ? 1 : 0);
        SqliteHelpers.Add(cmd, "$created_at", SqliteHelpers.FormatTimestamp(animation.CreatedAt));
        SqliteHelpers.Add(cmd, "$updated_at", SqliteHelpers.FormatTimestamp(animation.UpdatedAt));
        await cmd.ExecuteNonQueryAsync(ct);

        animation.Source = body;
        return ToDto(animation, await Privacy.OwnerNameAsync(conn, animation.OwnerId, ct));
    }

    public async Task<AnimationDto?> UpdateAsync(string id, UpdateAnimationRequest request, CancellationToken ct = default)
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
        existing.SceneCount = CountScenes(body);
        var cell = await resolver.SaveAsync(body, target, ContentRef.AnimationKey(existing.Id), oldRef, ct);
        existing.Source = cell.InlineValue;
        existing.ContentRef = cell.ContentRef;
        existing.ContentSize = cell.ContentSize;

        await using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = """
                UPDATE animation SET title = $title, source = $source, content_ref = $content_ref,
                  content_size = $content_size, scene_count = $scene_count,
                  owner_id = $owner_id, is_private = $is_private, updated_at = $updated_at
                WHERE id = $id
                """;
            SqliteHelpers.Add(cmd, "$id", existing.Id);
            SqliteHelpers.Add(cmd, "$title", existing.Title);
            SqliteHelpers.Add(cmd, "$source", existing.Source);
            SqliteHelpers.Add(cmd, "$content_ref", existing.ContentRef);
            SqliteHelpers.Add(cmd, "$content_size", existing.ContentSize);
            SqliteHelpers.Add(cmd, "$scene_count", existing.SceneCount);
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
            cmd.CommandText = "DELETE FROM animation WHERE id = $id";
            SqliteHelpers.Add(cmd, "$id", id);
            await cmd.ExecuteNonQueryAsync(ct);
        }

        await resolver.DeleteAsync(existing.ContentRef, ct);
        return true;
    }

    /// <summary>Scenes in the document. An animation that fails to parse counts as none.</summary>
    internal static int CountScenes(string? source)
    {
        if (string.IsNullOrWhiteSpace(source)) return 0;
        try
        {
            using var doc = JsonDocument.Parse(source);
            return doc.RootElement.ValueKind == JsonValueKind.Object
                && doc.RootElement.TryGetProperty("scenes", out var scenes)
                && scenes.ValueKind == JsonValueKind.Array
                    ? scenes.GetArrayLength()
                    : 0;
        }
        catch (JsonException)
        {
            return 0;
        }
    }

    private static async Task<Animation?> SelectAsync(SqliteConnection conn, string id, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT id, book_id, title, source, created_at, updated_at, content_ref, content_size, scene_count,
                   owner_id, is_private
            FROM animation WHERE id = $id LIMIT 1
            """;
        SqliteHelpers.Add(cmd, "$id", id);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) return null;
        return new Animation
        {
            Id = reader.GetString(0),
            BookId = reader.GetString(1),
            Title = reader.GetString(2),
            Source = reader.GetString(3),
            CreatedAt = SqliteHelpers.ReadTimestamp(reader, 4),
            UpdatedAt = SqliteHelpers.ReadTimestamp(reader, 5),
            ContentRef = SqliteHelpers.GetNullableString(reader, 6),
            ContentSize = reader.IsDBNull(7) ? null : reader.GetInt64(7),
            SceneCount = reader.IsDBNull(8) ? null : (int)reader.GetInt64(8),
            OwnerId = SqliteHelpers.GetNullableString(reader, 9),
            IsPrivate = Privacy.ReadFlag(reader, 10),
        };
    }

    private static AnimationDto ToDto(Animation d, string? ownerName) => new(
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

using System.Text.Json;
using BeeDocs.Api.Models;
using Microsoft.Data.Sqlite;

namespace BeeDocs.Api.Services;

public interface IProjectPlanService
{
    Task<IReadOnlyList<ProjectPlanSummaryDto>> ListByBookAsync(string bookId, CancellationToken ct = default);
    Task<ProjectPlanDto?> GetAsync(string id, CancellationToken ct = default);
    Task<ProjectPlanDto> CreateAsync(string bookId, CreateProjectPlanRequest request, CancellationToken ct = default);
    Task<ProjectPlanDto?> UpdateAsync(string id, UpdateProjectPlanRequest request, CancellationToken ct = default);
    Task<bool> DeleteAsync(string id, CancellationToken ct = default);
}

public sealed class ProjectPlanService(
    SqliteConnectionFactory db, ContentResolver resolver, ICurrentUserAccessor currentUser) : IProjectPlanService
{
    /// <summary>One empty task. The web editor owns the richer starter plans.</summary>
    public static string DefaultSource { get; } =
        """{"version":1,"tasks":[{"id":"task-1","title":"New task","kind":"task","start":null,"duration":1,"progress":0,"parentId":null,"predecessors":[],"assigneeId":null,"assigneeName":null}]}""";

    public async Task<IReadOnlyList<ProjectPlanSummaryDto>> ListByBookAsync(string bookId, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        var actor = currentUser.Current;
        cmd.CommandText = $"""
            SELECT id, book_id, title, source, updated_at, task_count, owner_id, is_private
            FROM project_plan WHERE book_id = $book_id{Privacy.DocumentSql("project_plan", actor)}
            ORDER BY updated_at DESC, title COLLATE NOCASE
            """;
        SqliteHelpers.Add(cmd, "$book_id", bookId);
        Privacy.BindViewer(cmd, actor);
        var list = new List<ProjectPlanSummaryDto>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            list.Add(new ProjectPlanSummaryDto(
                Id: reader.GetString(0),
                BookId: reader.GetString(1),
                Title: reader.GetString(2),
                TaskCount: reader.IsDBNull(5)
                    ? CountTasks(SqliteHelpers.GetNullableString(reader, 3))
                    : (int)reader.GetInt64(5),
                OwnerId: SqliteHelpers.GetNullableString(reader, 6),
                IsPrivate: Privacy.ReadFlag(reader, 7),
                UpdatedAt: SqliteHelpers.ReadTimestamp(reader, 4)));
        }
        return list;
    }

    public async Task<ProjectPlanDto?> GetAsync(string id, CancellationToken ct = default)
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

    public async Task<ProjectPlanDto> CreateAsync(string bookId, CreateProjectPlanRequest request, CancellationToken ct = default)
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
        var plan = new ProjectPlan
        {
            Id = SqliteHelpers.NewId(),
            BookId = bookId,
            Title = request.Title.Trim(),
            TaskCount = CountTasks(body),
            OwnerId = string.IsNullOrWhiteSpace(request.OwnerId) ? bookOwnerId ?? actor.Id : request.OwnerId.Trim(),
            IsPrivate = request.IsPrivate ?? false,
            CreatedAt = now,
            UpdatedAt = now,
        };
        Privacy.EnsurePrivateHasOwner(plan.IsPrivate, plan.OwnerId);

        var target = await ContentResolver.ProviderIdForBookAsync(conn, bookId, ct);
        var cell = await resolver.SaveAsync(body, target, ContentRef.ProjectKey(plan.Id), null, ct);
        plan.Source = cell.InlineValue;
        plan.ContentRef = cell.ContentRef;
        plan.ContentSize = cell.ContentSize;

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO project_plan (id, book_id, title, source, content_ref, content_size, task_count,
              owner_id, is_private, created_at, updated_at)
            VALUES ($id, $book_id, $title, $source, $content_ref, $content_size, $task_count,
              $owner_id, $is_private, $created_at, $updated_at)
            """;
        SqliteHelpers.Add(cmd, "$id", plan.Id);
        SqliteHelpers.Add(cmd, "$book_id", plan.BookId);
        SqliteHelpers.Add(cmd, "$title", plan.Title);
        SqliteHelpers.Add(cmd, "$source", plan.Source);
        SqliteHelpers.Add(cmd, "$content_ref", plan.ContentRef);
        SqliteHelpers.Add(cmd, "$content_size", plan.ContentSize);
        SqliteHelpers.Add(cmd, "$task_count", plan.TaskCount);
        SqliteHelpers.Add(cmd, "$owner_id", plan.OwnerId);
        SqliteHelpers.Add(cmd, "$is_private", plan.IsPrivate ? 1 : 0);
        SqliteHelpers.Add(cmd, "$created_at", SqliteHelpers.FormatTimestamp(plan.CreatedAt));
        SqliteHelpers.Add(cmd, "$updated_at", SqliteHelpers.FormatTimestamp(plan.UpdatedAt));
        await cmd.ExecuteNonQueryAsync(ct);

        plan.Source = body;
        return ToDto(plan, await Privacy.OwnerNameAsync(conn, plan.OwnerId, ct));
    }

    public async Task<ProjectPlanDto?> UpdateAsync(string id, UpdateProjectPlanRequest request, CancellationToken ct = default)
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
        existing.TaskCount = CountTasks(body);
        var cell = await resolver.SaveAsync(body, target, ContentRef.ProjectKey(existing.Id), oldRef, ct);
        existing.Source = cell.InlineValue;
        existing.ContentRef = cell.ContentRef;
        existing.ContentSize = cell.ContentSize;

        await using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = """
                UPDATE project_plan SET title = $title, source = $source, content_ref = $content_ref,
                  content_size = $content_size, task_count = $task_count,
                  owner_id = $owner_id, is_private = $is_private, updated_at = $updated_at
                WHERE id = $id
                """;
            SqliteHelpers.Add(cmd, "$id", existing.Id);
            SqliteHelpers.Add(cmd, "$title", existing.Title);
            SqliteHelpers.Add(cmd, "$source", existing.Source);
            SqliteHelpers.Add(cmd, "$content_ref", existing.ContentRef);
            SqliteHelpers.Add(cmd, "$content_size", existing.ContentSize);
            SqliteHelpers.Add(cmd, "$task_count", existing.TaskCount);
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
            cmd.CommandText = "DELETE FROM project_plan WHERE id = $id";
            SqliteHelpers.Add(cmd, "$id", id);
            await cmd.ExecuteNonQueryAsync(ct);
        }

        await resolver.DeleteAsync(existing.ContentRef, ct);
        return true;
    }

    /// <summary>Tasks in the plan. A document that fails to parse counts as none.</summary>
    internal static int CountTasks(string? source)
    {
        if (string.IsNullOrWhiteSpace(source)) return 0;
        try
        {
            using var doc = JsonDocument.Parse(source);
            if (doc.RootElement.ValueKind != JsonValueKind.Object
                || !doc.RootElement.TryGetProperty("tasks", out var tasks)
                || tasks.ValueKind != JsonValueKind.Array)
            {
                return 0;
            }

            return tasks.GetArrayLength();
        }
        catch (JsonException)
        {
            return 0;
        }
    }

    private static async Task<ProjectPlan?> SelectAsync(SqliteConnection conn, string id, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT id, book_id, title, source, created_at, updated_at, content_ref, content_size, task_count,
                   owner_id, is_private
            FROM project_plan WHERE id = $id LIMIT 1
            """;
        SqliteHelpers.Add(cmd, "$id", id);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) return null;
        return new ProjectPlan
        {
            Id = reader.GetString(0),
            BookId = reader.GetString(1),
            Title = reader.GetString(2),
            Source = reader.GetString(3),
            CreatedAt = SqliteHelpers.ReadTimestamp(reader, 4),
            UpdatedAt = SqliteHelpers.ReadTimestamp(reader, 5),
            ContentRef = SqliteHelpers.GetNullableString(reader, 6),
            ContentSize = reader.IsDBNull(7) ? null : reader.GetInt64(7),
            TaskCount = reader.IsDBNull(8) ? null : (int)reader.GetInt64(8),
            OwnerId = SqliteHelpers.GetNullableString(reader, 9),
            IsPrivate = Privacy.ReadFlag(reader, 10),
        };
    }

    private static ProjectPlanDto ToDto(ProjectPlan d, string? ownerName) => new(
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

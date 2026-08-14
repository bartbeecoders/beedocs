using BeeDocs.Api.Models;
using Microsoft.Data.Sqlite;

namespace BeeDocs.Api.Services;

public interface ISlideTemplateService
{
    Task<IReadOnlyList<SlideTemplateSummaryDto>> ListAsync(CancellationToken ct = default);
    Task<SlideTemplateDto?> GetAsync(string id, CancellationToken ct = default);
    Task<SlideTemplateDto> CreateAsync(CreateSlideTemplateRequest request, CancellationToken ct = default);
    Task<SlideTemplateDto?> UpdateAsync(string id, UpdateSlideTemplateRequest request, CancellationToken ct = default);
    Task<bool> DeleteAsync(string id, CancellationToken ct = default);
}

public sealed class SlideTemplateService(SqliteConnectionFactory db) : ISlideTemplateService
{
    public async Task<IReadOnlyList<SlideTemplateSummaryDto>> ListAsync(CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT id, name, source, updated_at
            FROM slide_template
            ORDER BY name COLLATE NOCASE
            """;
        var list = new List<SlideTemplateSummaryDto>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            list.Add(new SlideTemplateSummaryDto(
                Id: reader.GetString(0),
                Name: reader.GetString(1),
                SlideCount: SlideDeckService.CountSlides(SqliteHelpers.GetNullableString(reader, 2)),
                UpdatedAt: SqliteHelpers.ReadTimestamp(reader, 3)));
        }
        return list;
    }

    public async Task<SlideTemplateDto?> GetAsync(string id, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var row = await SelectAsync(conn, id, ct);
        return row is null ? null : ToDto(row);
    }

    public async Task<SlideTemplateDto> CreateAsync(CreateSlideTemplateRequest request, CancellationToken ct = default)
    {
        var now = DateTimeOffset.UtcNow;
        var template = new SlideTemplate
        {
            Id = SqliteHelpers.NewId(),
            Name = request.Name.Trim(),
            Source = request.Source,
            CreatedAt = now,
            UpdatedAt = now,
        };

        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO slide_template (id, name, source, created_at, updated_at)
            VALUES ($id, $name, $source, $created_at, $updated_at)
            """;
        SqliteHelpers.Add(cmd, "$id", template.Id);
        SqliteHelpers.Add(cmd, "$name", template.Name);
        SqliteHelpers.Add(cmd, "$source", template.Source);
        SqliteHelpers.Add(cmd, "$created_at", SqliteHelpers.FormatTimestamp(template.CreatedAt));
        SqliteHelpers.Add(cmd, "$updated_at", SqliteHelpers.FormatTimestamp(template.UpdatedAt));
        await cmd.ExecuteNonQueryAsync(ct);
        return ToDto(template);
    }

    public async Task<SlideTemplateDto?> UpdateAsync(string id, UpdateSlideTemplateRequest request, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var existing = await SelectAsync(conn, id, ct);
        if (existing is null) return null;

        existing.Name = request.Name.Trim();
        if (request.Source is not null)
            existing.Source = request.Source;
        existing.UpdatedAt = DateTimeOffset.UtcNow;

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            UPDATE slide_template SET name = $name, source = $source, updated_at = $updated_at
            WHERE id = $id
            """;
        SqliteHelpers.Add(cmd, "$id", existing.Id);
        SqliteHelpers.Add(cmd, "$name", existing.Name);
        SqliteHelpers.Add(cmd, "$source", existing.Source);
        SqliteHelpers.Add(cmd, "$updated_at", SqliteHelpers.FormatTimestamp(existing.UpdatedAt));
        await cmd.ExecuteNonQueryAsync(ct);
        return ToDto(existing);
    }

    public async Task<bool> DeleteAsync(string id, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "DELETE FROM slide_template WHERE id = $id";
        SqliteHelpers.Add(cmd, "$id", id);
        return await cmd.ExecuteNonQueryAsync(ct) > 0;
    }

    private static async Task<SlideTemplate?> SelectAsync(SqliteConnection conn, string id, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT id, name, source, created_at, updated_at
            FROM slide_template WHERE id = $id LIMIT 1
            """;
        SqliteHelpers.Add(cmd, "$id", id);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) return null;
        return new SlideTemplate
        {
            Id = reader.GetString(0),
            Name = reader.GetString(1),
            Source = reader.GetString(2),
            CreatedAt = SqliteHelpers.ReadTimestamp(reader, 3),
            UpdatedAt = SqliteHelpers.ReadTimestamp(reader, 4),
        };
    }

    private static SlideTemplateDto ToDto(SlideTemplate t) => new(
        Id: t.Id,
        Name: t.Name,
        Source: t.Source,
        CreatedAt: t.CreatedAt,
        UpdatedAt: t.UpdatedAt);
}

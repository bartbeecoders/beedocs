using BeeDocs.Api.Models;
using Microsoft.Data.Sqlite;

namespace BeeDocs.Api.Services;

/// <summary>
/// The four supported providers, and what to assume when the user only picks a kind.
/// </summary>
public static class LlmProviderKinds
{
    public const string OpenRouter = "openrouter";
    public const string XAi = "xai";
    public const string OpenAi = "openai";
    public const string LmStudio = "lmstudio";

    public static readonly IReadOnlyList<string> All = [OpenRouter, XAi, OpenAi, LmStudio];

    /// <summary>Accepts the spellings a UI or a hand-written request is likely to send.</summary>
    public static string? Normalize(string? raw) =>
        (raw ?? string.Empty).Trim().ToLowerInvariant().Replace(" ", "").Replace("-", "").Replace("_", "") switch
        {
            "openrouter" => OpenRouter,
            "xai" or "grok" or "x" => XAi,
            "openai" or "chatgpt" or "gpt" => OpenAi,
            "lmstudio" or "local" or "lm" => LmStudio,
            _ => null,
        };

    public static string DefaultBaseUrl(string kind) => kind switch
    {
        OpenRouter => "https://openrouter.ai/api/v1",
        XAi => "https://api.x.ai/v1",
        OpenAi => "https://api.openai.com/v1",
        LmStudio => "http://localhost:1234/v1",
        _ => "",
    };

    public static string DefaultName(string kind) => kind switch
    {
        OpenRouter => "OpenRouter",
        XAi => "xAI",
        OpenAi => "OpenAI",
        LmStudio => "LM Studio",
        _ => kind,
    };

    /// <summary>
    /// A starting point only — the UI fills a real picker from /models. LM Studio
    /// serves whatever model is loaded, so it gets no default at all.
    /// </summary>
    public static string DefaultModel(string kind) => kind switch
    {
        OpenRouter => "openai/gpt-4o-mini",
        XAi => "grok-3-mini",
        OpenAi => "gpt-4o-mini",
        _ => "",
    };

    /// <summary>LM Studio is normally unauthenticated; the hosted providers are not.</summary>
    public static bool RequiresKey(string kind) => kind != LmStudio;
}

/// <summary>
/// A provider with its key attached, for signing one upstream call. Passed between
/// services only — no endpoint returns this, and nothing here is serializable to a
/// client by accident because no route binds it.
/// </summary>
public sealed record LlmProviderSecret(
    string Id,
    string Kind,
    string Name,
    string BaseUrl,
    string? ApiKey,
    string Model
);

public interface ILlmProviderService
{
    Task<IReadOnlyList<LlmProviderDto>> ListAsync(CancellationToken ct = default);

    Task<LlmProviderDto?> GetAsync(string id, CancellationToken ct = default);

    Task<LlmProviderDto> CreateAsync(CreateLlmProviderRequest request, CancellationToken ct = default);

    Task<LlmProviderDto?> UpdateAsync(string id, UpdateLlmProviderRequest request, CancellationToken ct = default);

    Task<bool> DeleteAsync(string id, CancellationToken ct = default);

    /// <summary>
    /// Move a provider to the front of the sort order and enable it, atomically.
    /// "Default" is not a stored flag — <see cref="ResolveAsync"/> takes the first
    /// enabled row — so without this a client has to renumber every row itself,
    /// one request each, and a failure halfway leaves the order rewritten but the
    /// target not promoted. Returns null when the id is unknown.
    /// <para>
    /// A key-requiring provider with no stored key is promoted but <em>not</em>
    /// enabled: enabling it would make a 401 the default for every completion.
    /// </para>
    /// </summary>
    Task<LlmProviderDto?> MakeDefaultAsync(string id, CancellationToken ct = default);

    /// <summary>
    /// Load a provider together with its key. Pass null for the first enabled one.
    /// Returns null when the id is unknown, disabled, or nothing is configured.
    /// </summary>
    Task<LlmProviderSecret?> ResolveAsync(string? providerId, CancellationToken ct = default);

    /// <summary>Whether any stored key exists. Drives the startup warning about an unprotected API.</summary>
    Task<bool> AnyKeyStoredAsync(CancellationToken ct = default);
}

/// <summary>
/// CRUD over <c>llm_provider</c>. The key column is write-only: it is selected in
/// exactly one place (<see cref="ResolveAsync"/>, which feeds
/// <see cref="LlmClient"/>) and never reaches a DTO.
/// </summary>
public sealed class LlmProviderService(SqliteConnectionFactory db) : ILlmProviderService
{
    private const string SelectColumns =
        "id, kind, name, base_url, api_key, model, enabled, sort_order, created_at, updated_at";

    public async Task<IReadOnlyList<LlmProviderDto>> ListAsync(CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = $"""
            SELECT {SelectColumns} FROM llm_provider
            ORDER BY sort_order, created_at
            """;

        var list = new List<LlmProviderDto>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
            list.Add(ToDto(ReadEntity(reader)));
        return list;
    }

    public async Task<LlmProviderDto?> GetAsync(string id, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var row = await SelectAsync(conn, id, ct);
        return row is null ? null : ToDto(row);
    }

    public async Task<LlmProviderDto> CreateAsync(CreateLlmProviderRequest request, CancellationToken ct = default)
    {
        var kind = LlmProviderKinds.Normalize(request.Kind)
            ?? throw new ArgumentException(
                $"Unknown provider kind '{request.Kind}'. Use one of: {string.Join(", ", LlmProviderKinds.All)}.");

        var now = DateTimeOffset.UtcNow;
        var key = NormalizeKey(request.ApiKey);
        var row = new LlmProvider
        {
            Id = SqliteHelpers.NewId(),
            Kind = kind,
            Name = string.IsNullOrWhiteSpace(request.Name)
                ? LlmProviderKinds.DefaultName(kind)
                : request.Name.Trim(),
            BaseUrl = NormalizeBaseUrl(request.BaseUrl, kind),
            ApiKey = key,
            Model = request.Model?.Trim() is { Length: > 0 } model ? model : LlmProviderKinds.DefaultModel(kind),
            // Enabled unasked only when the row can actually answer. A hosted
            // provider created without a key becomes the first enabled row, i.e.
            // the default, and then 401s on every completion — a broken default
            // is worse than none, and the caller can still pass Enabled = true.
            Enabled = request.Enabled ?? (key is not null || !LlmProviderKinds.RequiresKey(kind)),
            CreatedAt = now,
            UpdatedAt = now,
        };

        await using var conn = await db.OpenConnectionAsync(ct);
        row.SortOrder = request.SortOrder ?? await NextSortOrderAsync(conn, ct);

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO llm_provider (id, kind, name, base_url, api_key, model, enabled, sort_order, created_at, updated_at)
            VALUES ($id, $kind, $name, $base_url, $api_key, $model, $enabled, $sort_order, $created_at, $updated_at)
            """;
        SqliteHelpers.Add(cmd, "$id", row.Id);
        SqliteHelpers.Add(cmd, "$kind", row.Kind);
        SqliteHelpers.Add(cmd, "$name", row.Name);
        SqliteHelpers.Add(cmd, "$base_url", row.BaseUrl);
        SqliteHelpers.Add(cmd, "$api_key", row.ApiKey);
        SqliteHelpers.Add(cmd, "$model", row.Model);
        SqliteHelpers.Add(cmd, "$enabled", row.Enabled ? 1 : 0);
        SqliteHelpers.Add(cmd, "$sort_order", row.SortOrder);
        SqliteHelpers.Add(cmd, "$created_at", SqliteHelpers.FormatTimestamp(row.CreatedAt));
        SqliteHelpers.Add(cmd, "$updated_at", SqliteHelpers.FormatTimestamp(row.UpdatedAt));
        await cmd.ExecuteNonQueryAsync(ct);
        return ToDto(row);
    }

    public async Task<LlmProviderDto?> UpdateAsync(
        string id,
        UpdateLlmProviderRequest request,
        CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var existing = await SelectAsync(conn, id, ct);
        if (existing is null) return null;

        if (!string.IsNullOrWhiteSpace(request.Name))
            existing.Name = request.Name.Trim();
        if (!string.IsNullOrWhiteSpace(request.BaseUrl))
            existing.BaseUrl = NormalizeBaseUrl(request.BaseUrl, existing.Kind);
        if (request.Model is not null)
            existing.Model = request.Model.Trim();
        if (request.Enabled is { } enabled)
            existing.Enabled = enabled;
        if (request.SortOrder is { } sortOrder)
            existing.SortOrder = sortOrder;

        // null leaves the stored key alone, "" clears it. Anything else replaces it.
        if (request.ApiKey is not null)
            existing.ApiKey = NormalizeKey(request.ApiKey);

        // A key-requiring provider with no key cannot answer, and an enabled one
        // is still what ResolveAsync hands every completion — so it would fail
        // them all. Enforced here rather than only in the UI: /api/llm is a public
        // REST surface, and clearing a key is the one path into this state that
        // the client-side gate cannot see.
        if (existing.Enabled && string.IsNullOrEmpty(existing.ApiKey)
            && LlmProviderKinds.RequiresKey(existing.Kind))
        {
            existing.Enabled = false;
        }

        existing.UpdatedAt = DateTimeOffset.UtcNow;

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            UPDATE llm_provider SET name = $name, base_url = $base_url, api_key = $api_key,
              model = $model, enabled = $enabled, sort_order = $sort_order, updated_at = $updated_at
            WHERE id = $id
            """;
        SqliteHelpers.Add(cmd, "$id", existing.Id);
        SqliteHelpers.Add(cmd, "$name", existing.Name);
        SqliteHelpers.Add(cmd, "$base_url", existing.BaseUrl);
        SqliteHelpers.Add(cmd, "$api_key", existing.ApiKey);
        SqliteHelpers.Add(cmd, "$model", existing.Model);
        SqliteHelpers.Add(cmd, "$enabled", existing.Enabled ? 1 : 0);
        SqliteHelpers.Add(cmd, "$sort_order", existing.SortOrder);
        SqliteHelpers.Add(cmd, "$updated_at", SqliteHelpers.FormatTimestamp(existing.UpdatedAt));
        await cmd.ExecuteNonQueryAsync(ct);
        return ToDto(existing);
    }

    public async Task<bool> DeleteAsync(string id, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "DELETE FROM llm_provider WHERE id = $id";
        SqliteHelpers.Add(cmd, "$id", id);
        return await cmd.ExecuteNonQueryAsync(ct) > 0;
    }

    public async Task<LlmProviderDto?> MakeDefaultAsync(string id, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var tx = (SqliteTransaction)await conn.BeginTransactionAsync(ct);

        var order = new List<string>();
        string? targetKind = null;
        string? targetKey = null;
        await using (var read = conn.CreateCommand())
        {
            read.Transaction = tx;
            read.CommandText = "SELECT id, kind, api_key FROM llm_provider ORDER BY sort_order, created_at";
            await using var reader = await read.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
            {
                var rowId = reader.GetString(0);
                order.Add(rowId);
                if (rowId != id) continue;
                targetKind = reader.GetString(1);
                targetKey = SqliteHelpers.GetNullableString(reader, 2);
            }
        }

        if (!order.Remove(id)) return null;
        order.Insert(0, id);

        // CreateAsync already refuses to birth a keyless hosted provider enabled,
        // because a 401-ing default is worse than no default. Promoting one here
        // would undo that in a single click, so this move renumbers it to the
        // front but leaves `enabled` exactly as it found it. Store a key and the
        // very next save turns it on, with the row already at position zero.
        var mayEnable = !string.IsNullOrEmpty(targetKey)
            || !LlmProviderKinds.RequiresKey(targetKind ?? string.Empty);

        for (var i = 0; i < order.Count; i++)
        {
            await using var cmd = conn.CreateCommand();
            cmd.Transaction = tx;
            // Only the promoted row is a content edit; renumbering the rest must not
            // bump their updated_at or every reorder looks like someone edited them.
            cmd.CommandText = order[i] == id
                ? mayEnable
                    ? "UPDATE llm_provider SET sort_order = $sort_order, enabled = 1, updated_at = $updated_at WHERE id = $id"
                    : "UPDATE llm_provider SET sort_order = $sort_order, updated_at = $updated_at WHERE id = $id"
                : "UPDATE llm_provider SET sort_order = $sort_order WHERE id = $id AND sort_order <> $sort_order";
            SqliteHelpers.Add(cmd, "$id", order[i]);
            SqliteHelpers.Add(cmd, "$sort_order", i);
            if (order[i] == id)
                SqliteHelpers.Add(cmd, "$updated_at", SqliteHelpers.FormatTimestamp(DateTimeOffset.UtcNow));
            await cmd.ExecuteNonQueryAsync(ct);
        }

        await tx.CommitAsync(ct);

        var promoted = await SelectAsync(conn, id, ct);
        return promoted is null ? null : ToDto(promoted);
    }

    public async Task<LlmProviderSecret?> ResolveAsync(string? providerId, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        if (string.IsNullOrWhiteSpace(providerId))
        {
            cmd.CommandText = $"""
                SELECT {SelectColumns} FROM llm_provider
                WHERE enabled = 1
                ORDER BY sort_order, created_at
                LIMIT 1
                """;
        }
        else
        {
            cmd.CommandText = $"SELECT {SelectColumns} FROM llm_provider WHERE id = $id LIMIT 1";
            SqliteHelpers.Add(cmd, "$id", providerId);
        }

        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) return null;

        var row = ReadEntity(reader);
        return new LlmProviderSecret(row.Id, row.Kind, row.Name, row.BaseUrl, row.ApiKey, row.Model);
    }

    public async Task<bool> AnyKeyStoredAsync(CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM llm_provider WHERE api_key IS NOT NULL AND api_key != ''";
        var count = await cmd.ExecuteScalarAsync(ct);
        return Convert.ToInt64(count) > 0;
    }

    private static async Task<LlmProvider?> SelectAsync(SqliteConnection conn, string id, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = $"SELECT {SelectColumns} FROM llm_provider WHERE id = $id LIMIT 1";
        SqliteHelpers.Add(cmd, "$id", id);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        return await reader.ReadAsync(ct) ? ReadEntity(reader) : null;
    }

    private static async Task<int> NextSortOrderAsync(SqliteConnection conn, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM llm_provider";
        var next = await cmd.ExecuteScalarAsync(ct);
        return Convert.ToInt32(next);
    }

    private static string NormalizeBaseUrl(string? raw, string kind)
    {
        var value = (raw ?? string.Empty).Trim().TrimEnd('/');
        if (value.Length == 0)
            return LlmProviderKinds.DefaultBaseUrl(kind);

        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri)
            || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
        {
            throw new ArgumentException($"Base URL '{raw}' must be an absolute http(s) URL.");
        }

        return value;
    }

    private static string? NormalizeKey(string? raw) =>
        string.IsNullOrWhiteSpace(raw) ? null : raw.Trim();

    private static LlmProvider ReadEntity(SqliteDataReader reader) => new()
    {
        Id = reader.GetString(0),
        Kind = reader.GetString(1),
        Name = reader.GetString(2),
        BaseUrl = reader.GetString(3),
        ApiKey = SqliteHelpers.GetNullableString(reader, 4),
        Model = reader.IsDBNull(5) ? string.Empty : reader.GetString(5),
        Enabled = !reader.IsDBNull(6) && reader.GetInt64(6) != 0,
        SortOrder = reader.IsDBNull(7) ? 0 : (int)reader.GetInt64(7),
        CreatedAt = SqliteHelpers.ReadTimestamp(reader, 8),
        UpdatedAt = SqliteHelpers.ReadTimestamp(reader, 9),
    };

    private static LlmProviderDto ToDto(LlmProvider p)
    {
        var hasKey = !string.IsNullOrEmpty(p.ApiKey);
        return new(
            Id: p.Id,
            Kind: p.Kind,
            Name: p.Name,
            BaseUrl: p.BaseUrl,
            Model: p.Model ?? string.Empty,
            Enabled: p.Enabled,
            HasKey: hasKey,
            KeyHint: hasKey ? KeyHint(p.ApiKey!) : null,
            RequiresKey: LlmProviderKinds.RequiresKey(p.Kind),
            SortOrder: p.SortOrder,
            CreatedAt: p.CreatedAt,
            UpdatedAt: p.UpdatedAt);
    }

    /// <summary>Last four characters — enough to recognise a key, useless to steal.</summary>
    private static string KeyHint(string key) => key.Length <= 4 ? new string('*', key.Length) : key[^4..];
}

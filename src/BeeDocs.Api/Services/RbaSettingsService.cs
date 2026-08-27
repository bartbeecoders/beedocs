using System.Text.Json;
using BeeDocs.Api.Models;
using Microsoft.Extensions.Options;

namespace BeeDocs.Api.Services;

/// <summary>The effective RBA configuration one request runs with, wherever it came from.</summary>
public sealed record RbaSettings(
    bool Enabled,
    string BaseUrl,
    string ApplicationCd,
    string PlantCd,
    bool SyncRoles,
    int TimeoutSeconds);

/// <summary>
/// RBA as a switchable login provider. The settings an admin saves on the
/// Settings page live in <c>app_setting</c> and take effect on the next login —
/// no restart — while <c>BeeDocs:Rba</c> from configuration remains the fallback
/// for deployments that manage it outside the app. Stored settings always win,
/// same precedence rule as <see cref="ApiKeySettingsService"/>. Nothing here is
/// secret (the URL and application code are not credentials), so unlike the API
/// key the stored values are read back to the admin UI in full.
/// </summary>
public sealed class RbaSettingsService(SqliteConnectionFactory db, IOptions<RbaOptions> options)
{
    private const string SettingKey = "rba.settings";

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    // null = not read yet; a non-null holder caches "read, and this is what was
    // stored" — including the nothing-stored case, so login never pays a query.
    private volatile StoredHolder? _stored;

    private sealed record StoredHolder(RbaSettings? Value);

    public async Task<bool> IsEnabledAsync(CancellationToken ct = default) =>
        (await GetEffectiveAsync(ct)).Enabled;

    public async Task<RbaSettings> GetEffectiveAsync(CancellationToken ct = default) =>
        await GetStoredAsync(ct) ?? FromConfig();

    public async Task<RbaSettingsDto> GetStatusAsync(CancellationToken ct = default)
    {
        var stored = await GetStoredAsync(ct);
        var effective = stored ?? FromConfig();
        return ToDto(effective, stored is not null ? "settings" : "config");
    }

    /// <summary>Full replace — the settings form always submits every field.</summary>
    /// <exception cref="ArgumentException">Enabled with no base URL, or an invalid URL.</exception>
    public async Task<RbaSettingsDto> SetAsync(UpdateRbaSettingsRequest request, CancellationToken ct = default)
    {
        var settings = new RbaSettings(
            Enabled: request.Enabled,
            BaseUrl: (request.BaseUrl ?? "").Trim().TrimEnd('/'),
            ApplicationCd: ((request.ApplicationCd ?? "").Trim() is { Length: > 0 } app ? app : "DOC").ToUpperInvariant(),
            PlantCd: (request.PlantCd ?? "").Trim(),
            SyncRoles: request.SyncRoles ?? true,
            TimeoutSeconds: request.TimeoutSeconds is > 0 and <= 120 ? request.TimeoutSeconds.Value : 15);

        if (settings.Enabled)
        {
            if (settings.BaseUrl.Length == 0)
                throw new ArgumentException("An RBA base URL is required to enable RBA sign-in.");
            if (!Uri.TryCreate(settings.BaseUrl, UriKind.Absolute, out var uri)
                || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
            {
                throw new ArgumentException("The RBA base URL must be an absolute http(s) URL.");
            }
        }

        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO app_setting (key, value, updated_at)
            VALUES ($key, $value, $updated_at)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
            """;
        SqliteHelpers.Add(cmd, "$key", SettingKey);
        SqliteHelpers.Add(cmd, "$value", JsonSerializer.Serialize(settings, Json));
        SqliteHelpers.Add(cmd, "$updated_at", SqliteHelpers.FormatTimestamp(DateTimeOffset.UtcNow));
        await cmd.ExecuteNonQueryAsync(ct);

        _stored = new StoredHolder(settings);
        return ToDto(settings, "settings");
    }

    /// <summary>Drop the stored settings so the server configuration (or the defaults) applies again.</summary>
    public async Task<RbaSettingsDto> ClearAsync(CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "DELETE FROM app_setting WHERE key = $key";
        SqliteHelpers.Add(cmd, "$key", SettingKey);
        await cmd.ExecuteNonQueryAsync(ct);

        _stored = new StoredHolder(null);
        return ToDto(FromConfig(), "config");
    }

    private async Task<RbaSettings?> GetStoredAsync(CancellationToken ct)
    {
        if (_stored is { } cached) return cached.Value;

        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT value FROM app_setting WHERE key = $key LIMIT 1";
        SqliteHelpers.Add(cmd, "$key", SettingKey);
        var raw = await cmd.ExecuteScalarAsync(ct) as string;

        RbaSettings? value = null;
        if (!string.IsNullOrWhiteSpace(raw))
        {
            try
            {
                value = JsonSerializer.Deserialize<RbaSettings>(raw, Json);
            }
            catch (JsonException)
            {
                // A hand-edited or corrupt row must not take logins down with it;
                // falling back to configuration is the least surprising recovery.
            }
        }

        _stored = new StoredHolder(value);
        return value;
    }

    private RbaSettings FromConfig()
    {
        var o = options.Value;
        return new RbaSettings(
            Enabled: o.Enabled,
            BaseUrl: o.BaseUrl.Trim().TrimEnd('/'),
            ApplicationCd: string.IsNullOrWhiteSpace(o.ApplicationCd) ? "DOC" : o.ApplicationCd.Trim().ToUpperInvariant(),
            PlantCd: o.PlantCd.Trim(),
            SyncRoles: o.SyncRoles,
            TimeoutSeconds: o.TimeoutSeconds is > 0 and <= 120 ? o.TimeoutSeconds : 15);
    }

    private static RbaSettingsDto ToDto(RbaSettings s, string source) => new(
        Enabled: s.Enabled,
        BaseUrl: s.BaseUrl,
        ApplicationCd: s.ApplicationCd,
        PlantCd: s.PlantCd,
        SyncRoles: s.SyncRoles,
        TimeoutSeconds: s.TimeoutSeconds,
        Source: source);
}

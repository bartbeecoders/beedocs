using BeeDocs.Api.Models;
using Microsoft.Extensions.Options;

namespace BeeDocs.Api.Services;

/// <summary>
/// The shared machine key — what protects <c>/api/v1</c> and <c>/api/llm</c>, and
/// how non-browser clients (MCP, publishing apps) authenticate when sign-in is on.
///
/// The key an admin saves on the Settings page is stored in <c>app_setting</c> and
/// takes effect immediately; <c>BeeDocs:ApiKey</c> from configuration remains as a
/// fallback for deployments that manage the key outside the app. A stored key
/// always wins, so a UI rotation never needs a restart and never fights the env var.
/// The stored value is write-only in the same sense as <c>llm_provider.api_key</c>:
/// no endpoint returns it — only whether one exists and its last four characters.
/// </summary>
public sealed class ApiKeySettingsService(SqliteConnectionFactory db, IOptions<ApiKeyOptions> options)
{
    private const string SettingKey = "api_key";

    // The stored key, cached after the first read: "" is "read, nothing stored",
    // null is "not read yet". Every /api request consults this, so it must not
    // cost a query each time; SetAsync is the only writer and refreshes it.
    private volatile string? _stored;

    /// <summary>The key requests are checked against: stored if present, else configured. Null = no auth.</summary>
    public async Task<string?> GetEffectiveKeyAsync(CancellationToken ct = default)
    {
        var stored = _stored ?? await LoadAsync(ct);
        if (stored.Length > 0) return stored;

        var configured = options.Value.ApiKey?.Trim();
        return string.IsNullOrEmpty(configured) ? null : configured;
    }

    /// <summary>False when no key is configured at all — absence must not match absence.</summary>
    public async Task<bool> MatchesAsync(string provided, CancellationToken ct = default)
    {
        var expected = await GetEffectiveKeyAsync(ct);
        return !string.IsNullOrEmpty(expected) && FixedTimeEquals(provided, expected);
    }

    public async Task<ApiKeyStatusDto> GetStatusAsync(CancellationToken ct = default)
    {
        var stored = _stored ?? await LoadAsync(ct);
        if (stored.Length > 0)
            return new ApiKeyStatusDto(HasKey: true, Source: "settings", KeyHint: KeyHint(stored));

        var configured = options.Value.ApiKey?.Trim();
        return string.IsNullOrEmpty(configured)
            ? new ApiKeyStatusDto(HasKey: false, Source: null, KeyHint: null)
            : new ApiKeyStatusDto(HasKey: true, Source: "config", KeyHint: KeyHint(configured));
    }

    /// <summary>
    /// Stores a new key, or clears the stored one when <paramref name="key"/> is
    /// empty — after which a configured <c>BeeDocs:ApiKey</c>, if any, applies again.
    /// </summary>
    public async Task<ApiKeyStatusDto> SetAsync(string? key, CancellationToken ct = default)
    {
        var value = key?.Trim() ?? string.Empty;

        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        if (value.Length == 0)
        {
            cmd.CommandText = "DELETE FROM app_setting WHERE key = $key";
            SqliteHelpers.Add(cmd, "$key", SettingKey);
        }
        else
        {
            cmd.CommandText = """
                INSERT INTO app_setting (key, value, updated_at)
                VALUES ($key, $value, $updated_at)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
                """;
            SqliteHelpers.Add(cmd, "$key", SettingKey);
            SqliteHelpers.Add(cmd, "$value", value);
            SqliteHelpers.Add(cmd, "$updated_at", SqliteHelpers.FormatTimestamp(DateTimeOffset.UtcNow));
        }
        await cmd.ExecuteNonQueryAsync(ct);

        _stored = value;
        return await GetStatusAsync(ct);
    }

    private async Task<string> LoadAsync(CancellationToken ct)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT value FROM app_setting WHERE key = $key LIMIT 1";
        SqliteHelpers.Add(cmd, "$key", SettingKey);
        var value = (await cmd.ExecuteScalarAsync(ct) as string)?.Trim() ?? string.Empty;
        _stored = value;
        return value;
    }

    /// <summary>Last four characters — enough to recognise a key, useless to steal.</summary>
    private static string KeyHint(string key) => key.Length <= 4 ? new string('*', key.Length) : key[^4..];

    /// <summary>Returns false for a length mismatch rather than throwing, so it is safe on attacker-chosen input.</summary>
    public static bool FixedTimeEquals(string a, string b) =>
        System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(
            System.Text.Encoding.UTF8.GetBytes(a),
            System.Text.Encoding.UTF8.GetBytes(b));
}

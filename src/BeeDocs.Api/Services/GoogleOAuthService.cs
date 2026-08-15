using System.Security.Cryptography;
using System.Text;
using Google.Apis.Auth.OAuth2.Requests;
using Google.Apis.Drive.v3;

namespace BeeDocs.Api.Services;

/// <summary>Outcome of the OAuth callback, rendered as a tiny HTML page.</summary>
public sealed record GoogleConnectResult(bool Ok, string Message);

/// <summary>
/// The Google Drive consent flow: builds the authorization URL, verifies the
/// signed state that ties a callback to a provider row, exchanges the code, and
/// leaves the refresh token + ensured Drive folder on that row. The callback is
/// necessarily anonymous (Google's redirect carries no session), so the
/// HMAC-signed state is its authentication.
/// </summary>
public sealed class GoogleOAuthService(
    IStorageProviderService providers,
    SqliteConnectionFactory db,
    ILogger<GoogleOAuthService> logger)
{
    private const string StateKeySetting = "storage.oauth_state_key";
    private static readonly TimeSpan StateLifetime = TimeSpan.FromMinutes(10);

    /// <summary>The Drive folder all BeeDocs content objects are created in.</summary>
    private const string FolderName = "BeeDocs";

    /// <summary>
    /// Build the consent URL for a provider. Throws <see cref="ArgumentException"/>
    /// when the provider is missing, not Google Drive, or has no client credentials.
    /// </summary>
    public async Task<string> BuildConnectUrlAsync(string providerId, string redirectUri, CancellationToken ct = default)
    {
        var secret = await providers.ResolveAsync(providerId, ct)
            ?? throw new ArgumentException("Unknown storage provider.");
        if (secret.Kind != StorageProviderKinds.GoogleDrive)
            throw new ArgumentException("Only Google Drive providers use the consent flow.");
        if (string.IsNullOrEmpty(secret.GoogleClientId) || string.IsNullOrEmpty(secret.GoogleClientSecret))
            throw new ArgumentException("Store an OAuth client id and client secret first, then connect.");

        var flow = GoogleDriveContentStore.CreateFlow(secret.GoogleClientId, secret.GoogleClientSecret);
        var request = (GoogleAuthorizationCodeRequestUrl)flow.CreateAuthorizationCodeRequest(redirectUri);
        // offline + consent: without both, a repeat consent for the same client
        // returns no refresh token and the connect silently produces a provider
        // that stops working within an hour.
        request.AccessType = "offline";
        request.Prompt = "consent";
        request.State = await CreateStateAsync(providerId, ct);
        return request.Build().ToString();
    }

    /// <summary>Verify the state, exchange the code, ensure the Drive folder, store the tokens.</summary>
    public async Task<GoogleConnectResult> HandleCallbackAsync(
        string? code, string? state, string redirectUri, CancellationToken ct = default)
    {
        if (string.IsNullOrEmpty(code))
            return new(false, "Google did not return an authorization code. Consent may have been cancelled.");

        var providerId = await VerifyStateAsync(state, ct);
        if (providerId is null)
            return new(false, "This authorization link is invalid or has expired. Start the connect again from Settings.");

        var secret = await providers.ResolveAsync(providerId, ct);
        if (secret is null || string.IsNullOrEmpty(secret.GoogleClientId) || string.IsNullOrEmpty(secret.GoogleClientSecret))
            return new(false, "The storage provider changed while the consent was in flight. Start the connect again.");

        try
        {
            var flow = GoogleDriveContentStore.CreateFlow(secret.GoogleClientId, secret.GoogleClientSecret);
            var token = await flow.ExchangeCodeForTokenAsync("beedocs", code, redirectUri, ct);
            if (string.IsNullOrEmpty(token.RefreshToken))
                return new(false, "Google returned no refresh token. Remove the app's access at myaccount.google.com/permissions and connect again.");

            var folderId = await EnsureFolderAsync(secret with { GoogleRefreshToken = token.RefreshToken }, ct);
            await providers.StoreGoogleTokensAsync(providerId, token.RefreshToken, folderId, ct);
            return new(true, $"Google Drive is connected. Content will be stored in a '{FolderName}' folder.");
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Google Drive connect failed for provider {ProviderId}", providerId);
            return new(false, $"Connecting Google Drive failed: {ex.GetBaseException().Message}");
        }
    }

    /// <summary>
    /// Find the app's folder or create it. The drive.file scope only sees files
    /// this app created, so a name match cannot collide with the user's own folders.
    /// </summary>
    private static async Task<string> EnsureFolderAsync(StorageProviderSecret secret, CancellationToken ct)
    {
        var drive = GoogleDriveContentStore.CreateService(secret);

        var list = drive.Files.List();
        list.Q = $"name = '{FolderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false";
        list.Fields = "files(id)";
        var existing = await list.ExecuteAsync(ct);
        if (existing.Files is { Count: > 0 })
            return existing.Files[0].Id;

        var create = drive.Files.Create(new Google.Apis.Drive.v3.Data.File
        {
            Name = FolderName,
            MimeType = "application/vnd.google-apps.folder",
        });
        create.Fields = "id";
        return (await create.ExecuteAsync(ct)).Id;
    }

    // --- state: base64url(providerId|expiresUnix|nonce).base64url(hmac) ---

    private async Task<string> CreateStateAsync(string providerId, CancellationToken ct)
    {
        var payload = $"{providerId}|{DateTimeOffset.UtcNow.Add(StateLifetime).ToUnixTimeSeconds()}|{Guid.NewGuid():N}";
        var payloadBytes = Encoding.UTF8.GetBytes(payload);
        var mac = HMACSHA256.HashData(await GetStateKeyAsync(ct), payloadBytes);
        return $"{Base64Url(payloadBytes)}.{Base64Url(mac)}";
    }

    private async Task<string?> VerifyStateAsync(string? state, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(state)) return null;
        var dot = state.IndexOf('.');
        if (dot <= 0) return null;

        byte[] payloadBytes;
        byte[] mac;
        try
        {
            payloadBytes = FromBase64Url(state[..dot]);
            mac = FromBase64Url(state[(dot + 1)..]);
        }
        catch (FormatException)
        {
            return null;
        }

        var expected = HMACSHA256.HashData(await GetStateKeyAsync(ct), payloadBytes);
        if (!CryptographicOperations.FixedTimeEquals(mac, expected)) return null;

        var parts = Encoding.UTF8.GetString(payloadBytes).Split('|');
        if (parts.Length != 3) return null;
        if (!long.TryParse(parts[1], out var expires)) return null;
        if (DateTimeOffset.FromUnixTimeSeconds(expires) < DateTimeOffset.UtcNow) return null;
        return parts[0];
    }

    /// <summary>
    /// The HMAC key lives in app_setting rather than memory so a process restart
    /// between opening the consent page and Google's redirect does not invalidate
    /// the flow. Created on first use; the INSERT-if-absent makes a concurrent
    /// first use converge on one key.
    /// </summary>
    private async Task<byte[]> GetStateKeyAsync(CancellationToken ct)
    {
        await using var conn = await db.OpenConnectionAsync(ct);

        await using (var insert = conn.CreateCommand())
        {
            insert.CommandText = """
                INSERT INTO app_setting (key, value, updated_at)
                SELECT $key, $value, $updated_at
                WHERE NOT EXISTS (SELECT 1 FROM app_setting WHERE key = $key)
                """;
            SqliteHelpers.Add(insert, "$key", StateKeySetting);
            SqliteHelpers.Add(insert, "$value", Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)));
            SqliteHelpers.Add(insert, "$updated_at", SqliteHelpers.FormatTimestamp(DateTimeOffset.UtcNow));
            await insert.ExecuteNonQueryAsync(ct);
        }

        await using var read = conn.CreateCommand();
        read.CommandText = "SELECT value FROM app_setting WHERE key = $key";
        SqliteHelpers.Add(read, "$key", StateKeySetting);
        var value = (string?)await read.ExecuteScalarAsync(ct)
            ?? throw new InvalidOperationException("OAuth state key vanished mid-read.");
        return Convert.FromBase64String(value);
    }

    private static string Base64Url(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static byte[] FromBase64Url(string value)
    {
        var s = value.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(s.PadRight(s.Length + (4 - s.Length % 4) % 4, '='));
    }
}

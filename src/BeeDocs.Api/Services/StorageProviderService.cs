using BeeDocs.Api.Models;
using Microsoft.Data.Sqlite;

namespace BeeDocs.Api.Services;

/// <summary>The supported storage backends, and what to assume when the user only picks a kind.</summary>
public static class StorageProviderKinds
{
    public const string AzureBlob = "azure-blob";
    public const string GoogleDrive = "google-drive";

    public static readonly IReadOnlyList<string> All = [AzureBlob, GoogleDrive];

    /// <summary>Accepts the spellings a UI or a hand-written request is likely to send.</summary>
    public static string? Normalize(string? raw) =>
        (raw ?? string.Empty).Trim().ToLowerInvariant().Replace(" ", "").Replace("-", "").Replace("_", "") switch
        {
            "azureblob" or "azure" or "blob" or "azurestorage" => AzureBlob,
            "googledrive" or "google" or "drive" or "gdrive" => GoogleDrive,
            _ => null,
        };

    public static string DefaultName(string kind) => kind switch
    {
        AzureBlob => "Azure Blob Storage",
        GoogleDrive => "Google Drive",
        _ => kind,
    };

    public const string DefaultAzureContainer = "beedocs";
}

/// <summary>
/// A provider with its secrets attached, for reaching the backend. Passed between
/// services only — no endpoint returns this, and nothing here is serializable to a
/// client by accident because no route binds it.
/// </summary>
public sealed record StorageProviderSecret(
    string Id,
    string Kind,
    string Name,
    string? AzureConnectionString,
    string AzureContainer,
    string? GoogleClientId,
    string? GoogleClientSecret,
    string? GoogleRefreshToken,
    string? GoogleFolderId,
    DateTimeOffset UpdatedAt
)
{
    /// <summary>
    /// Whether the provider can actually answer a call. This is the one state the
    /// UI shows and the shelf-assign endpoint checks — there is no enabled flag.
    /// </summary>
    public bool IsReady => Kind switch
    {
        StorageProviderKinds.AzureBlob => !string.IsNullOrEmpty(AzureConnectionString),
        StorageProviderKinds.GoogleDrive => !string.IsNullOrEmpty(GoogleRefreshToken)
            && !string.IsNullOrEmpty(GoogleClientId)
            && !string.IsNullOrEmpty(GoogleClientSecret),
        _ => false,
    };
}

public interface IStorageProviderService
{
    Task<IReadOnlyList<StorageProviderDto>> ListAsync(CancellationToken ct = default);

    Task<StorageProviderDto?> GetAsync(string id, CancellationToken ct = default);

    Task<StorageProviderDto> CreateAsync(CreateStorageProviderRequest request, CancellationToken ct = default);

    Task<StorageProviderDto?> UpdateAsync(string id, UpdateStorageProviderRequest request, CancellationToken ct = default);

    /// <summary>
    /// Deletes the row. Throws <see cref="InvalidOperationException"/> while any
    /// shelf is assigned to the provider or any content row's body still lives
    /// there — deleting the credentials first would strand those bodies.
    /// </summary>
    Task<bool> DeleteAsync(string id, CancellationToken ct = default);

    /// <summary>
    /// Load a provider together with its secrets. The single place the secret
    /// columns leave the database. Returns null when the id is unknown.
    /// </summary>
    Task<StorageProviderSecret?> ResolveAsync(string id, CancellationToken ct = default);

    /// <summary>Called only by the Google OAuth callback once consent completed.</summary>
    Task<bool> StoreGoogleTokensAsync(string id, string refreshToken, string folderId, CancellationToken ct = default);
}

/// <summary>
/// CRUD over <c>storage_provider</c>. The secret columns are write-only: they are
/// selected in exactly one place (<see cref="ResolveAsync"/>, which feeds the
/// content stores and the OAuth flow) and never reach a DTO.
/// </summary>
public sealed class StorageProviderService(SqliteConnectionFactory db) : IStorageProviderService
{
    private const string SelectColumns =
        "id, kind, name, azure_connection_string, azure_container, google_client_id, "
        + "google_client_secret, google_refresh_token, google_folder_id, created_at, updated_at";

    /// <summary>The four tables whose bodies can point at a provider.</summary>
    private static readonly string[] ContentTables = ["page", "page_revision", "diagram", "slide_deck"];

    public async Task<IReadOnlyList<StorageProviderDto>> ListAsync(CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = $"""
            SELECT {SelectColumns},
              (SELECT COUNT(*) FROM shelf WHERE storage_provider_id = storage_provider.id) AS shelf_count
            FROM storage_provider
            ORDER BY created_at
            """;

        var list = new List<StorageProviderDto>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
            list.Add(ToDto(ReadEntity(reader), shelfCount: (int)reader.GetInt64(11)));
        return list;
    }

    public async Task<StorageProviderDto?> GetAsync(string id, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var row = await SelectAsync(conn, id, ct);
        return row is null ? null : ToDto(row, await ShelvesUsingAsync(conn, id, ct));
    }

    public async Task<StorageProviderDto> CreateAsync(CreateStorageProviderRequest request, CancellationToken ct = default)
    {
        var kind = StorageProviderKinds.Normalize(request.Kind)
            ?? throw new ArgumentException(
                $"Unknown storage provider kind '{request.Kind}'. Use one of: {string.Join(", ", StorageProviderKinds.All)}.");

        var now = DateTimeOffset.UtcNow;
        var row = new StorageProvider
        {
            Id = SqliteHelpers.NewId(),
            Kind = kind,
            Name = string.IsNullOrWhiteSpace(request.Name)
                ? StorageProviderKinds.DefaultName(kind)
                : request.Name.Trim(),
            AzureConnectionString = kind == StorageProviderKinds.AzureBlob ? NormalizeSecret(request.ConnectionString) : null,
            AzureContainer = kind == StorageProviderKinds.AzureBlob ? NormalizeContainer(request.Container) : null,
            GoogleClientId = kind == StorageProviderKinds.GoogleDrive ? NormalizeSecret(request.ClientId) : null,
            GoogleClientSecret = kind == StorageProviderKinds.GoogleDrive ? NormalizeSecret(request.ClientSecret) : null,
            CreatedAt = now,
            UpdatedAt = now,
        };

        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO storage_provider (id, kind, name, azure_connection_string, azure_container,
              google_client_id, google_client_secret, google_refresh_token, google_folder_id,
              created_at, updated_at)
            VALUES ($id, $kind, $name, $azure_connection_string, $azure_container,
              $google_client_id, $google_client_secret, NULL, NULL, $created_at, $updated_at)
            """;
        SqliteHelpers.Add(cmd, "$id", row.Id);
        SqliteHelpers.Add(cmd, "$kind", row.Kind);
        SqliteHelpers.Add(cmd, "$name", row.Name);
        SqliteHelpers.Add(cmd, "$azure_connection_string", row.AzureConnectionString);
        SqliteHelpers.Add(cmd, "$azure_container", row.AzureContainer);
        SqliteHelpers.Add(cmd, "$google_client_id", row.GoogleClientId);
        SqliteHelpers.Add(cmd, "$google_client_secret", row.GoogleClientSecret);
        SqliteHelpers.Add(cmd, "$created_at", SqliteHelpers.FormatTimestamp(row.CreatedAt));
        SqliteHelpers.Add(cmd, "$updated_at", SqliteHelpers.FormatTimestamp(row.UpdatedAt));
        await cmd.ExecuteNonQueryAsync(ct);
        return ToDto(row, shelfCount: 0);
    }

    public async Task<StorageProviderDto?> UpdateAsync(
        string id,
        UpdateStorageProviderRequest request,
        CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var existing = await SelectAsync(conn, id, ct);
        if (existing is null) return null;

        if (!string.IsNullOrWhiteSpace(request.Name))
            existing.Name = request.Name.Trim();

        if (existing.Kind == StorageProviderKinds.AzureBlob)
        {
            if (request.Container is not null)
                existing.AzureContainer = NormalizeContainer(request.Container);
            // null leaves the stored value alone, "" clears it. Anything else replaces it.
            if (request.ConnectionString is not null)
                existing.AzureConnectionString = NormalizeSecret(request.ConnectionString);
        }
        else if (existing.Kind == StorageProviderKinds.GoogleDrive)
        {
            var credentialsChanged = false;
            if (request.ClientId is not null)
            {
                var next = NormalizeSecret(request.ClientId);
                credentialsChanged = next != existing.GoogleClientId;
                existing.GoogleClientId = next;
            }
            if (request.ClientSecret is not null)
            {
                var next = NormalizeSecret(request.ClientSecret);
                credentialsChanged = credentialsChanged || next != existing.GoogleClientSecret;
                existing.GoogleClientSecret = next;
            }
            // A refresh token is minted for one client id/secret pair; under any
            // other pair it can only produce auth errors, so changing either
            // forces a fresh Connect.
            if (credentialsChanged)
            {
                existing.GoogleRefreshToken = null;
                existing.GoogleFolderId = null;
            }
        }

        existing.UpdatedAt = DateTimeOffset.UtcNow;

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            UPDATE storage_provider SET name = $name,
              azure_connection_string = $azure_connection_string, azure_container = $azure_container,
              google_client_id = $google_client_id, google_client_secret = $google_client_secret,
              google_refresh_token = $google_refresh_token, google_folder_id = $google_folder_id,
              updated_at = $updated_at
            WHERE id = $id
            """;
        SqliteHelpers.Add(cmd, "$id", existing.Id);
        SqliteHelpers.Add(cmd, "$name", existing.Name);
        SqliteHelpers.Add(cmd, "$azure_connection_string", existing.AzureConnectionString);
        SqliteHelpers.Add(cmd, "$azure_container", existing.AzureContainer);
        SqliteHelpers.Add(cmd, "$google_client_id", existing.GoogleClientId);
        SqliteHelpers.Add(cmd, "$google_client_secret", existing.GoogleClientSecret);
        SqliteHelpers.Add(cmd, "$google_refresh_token", existing.GoogleRefreshToken);
        SqliteHelpers.Add(cmd, "$google_folder_id", existing.GoogleFolderId);
        SqliteHelpers.Add(cmd, "$updated_at", SqliteHelpers.FormatTimestamp(existing.UpdatedAt));
        await cmd.ExecuteNonQueryAsync(ct);
        return ToDto(existing, await ShelvesUsingAsync(conn, id, ct));
    }

    public async Task<bool> DeleteAsync(string id, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);

        var shelves = await ShelvesUsingAsync(conn, id, ct);
        if (shelves > 0)
        {
            throw new InvalidOperationException(
                $"This provider still stores {shelves} shelf/shelves. Move them to Local storage first.");
        }

        // A shelf can be re-pointed while some of its rows still hold bodies at
        // the old provider (an interrupted move), so the shelf count alone does
        // not prove the credentials are unneeded.
        foreach (var table in ContentTables)
        {
            await using var probe = conn.CreateCommand();
            // Table names are compile-time constants from ContentTables.
            probe.CommandText = $"SELECT COUNT(*) FROM {table} WHERE content_ref LIKE $prefix";
            SqliteHelpers.Add(probe, "$prefix", id + ":%");
            if (Convert.ToInt64(await probe.ExecuteScalarAsync(ct)) > 0)
            {
                throw new InvalidOperationException(
                    "Content bodies still live at this provider (an earlier move may not have finished). "
                    + "Re-run the shelf move, then delete it.");
            }
        }

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "DELETE FROM storage_provider WHERE id = $id";
        SqliteHelpers.Add(cmd, "$id", id);
        return await cmd.ExecuteNonQueryAsync(ct) > 0;
    }

    public async Task<StorageProviderSecret?> ResolveAsync(string id, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var row = await SelectAsync(conn, id, ct);
        return row is null ? null : ToSecret(row);
    }

    public async Task<bool> StoreGoogleTokensAsync(
        string id, string refreshToken, string folderId, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            UPDATE storage_provider
            SET google_refresh_token = $token, google_folder_id = $folder, updated_at = $updated_at
            WHERE id = $id AND kind = $kind
            """;
        SqliteHelpers.Add(cmd, "$id", id);
        SqliteHelpers.Add(cmd, "$kind", StorageProviderKinds.GoogleDrive);
        SqliteHelpers.Add(cmd, "$token", refreshToken);
        SqliteHelpers.Add(cmd, "$folder", folderId);
        SqliteHelpers.Add(cmd, "$updated_at", SqliteHelpers.FormatTimestamp(DateTimeOffset.UtcNow));
        return await cmd.ExecuteNonQueryAsync(ct) > 0;
    }

    private static async Task<int> ShelvesUsingAsync(SqliteConnection conn, string id, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM shelf WHERE storage_provider_id = $id";
        SqliteHelpers.Add(cmd, "$id", id);
        return Convert.ToInt32(await cmd.ExecuteScalarAsync(ct));
    }

    private static async Task<StorageProvider?> SelectAsync(SqliteConnection conn, string id, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = $"SELECT {SelectColumns} FROM storage_provider WHERE id = $id LIMIT 1";
        SqliteHelpers.Add(cmd, "$id", id);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        return await reader.ReadAsync(ct) ? ReadEntity(reader) : null;
    }

    private static string? NormalizeSecret(string? raw) =>
        string.IsNullOrWhiteSpace(raw) ? null : raw.Trim();

    private static string NormalizeContainer(string? raw)
    {
        var value = (raw ?? string.Empty).Trim().ToLowerInvariant();
        return value.Length == 0 ? StorageProviderKinds.DefaultAzureContainer : value;
    }

    private static StorageProvider ReadEntity(SqliteDataReader reader) => new()
    {
        Id = reader.GetString(0),
        Kind = reader.GetString(1),
        Name = reader.GetString(2),
        AzureConnectionString = SqliteHelpers.GetNullableString(reader, 3),
        AzureContainer = SqliteHelpers.GetNullableString(reader, 4),
        GoogleClientId = SqliteHelpers.GetNullableString(reader, 5),
        GoogleClientSecret = SqliteHelpers.GetNullableString(reader, 6),
        GoogleRefreshToken = SqliteHelpers.GetNullableString(reader, 7),
        GoogleFolderId = SqliteHelpers.GetNullableString(reader, 8),
        CreatedAt = SqliteHelpers.ReadTimestamp(reader, 9),
        UpdatedAt = SqliteHelpers.ReadTimestamp(reader, 10),
    };

    private static StorageProviderSecret ToSecret(StorageProvider p) => new(
        p.Id,
        p.Kind,
        p.Name,
        p.AzureConnectionString,
        p.AzureContainer is { Length: > 0 } c ? c : StorageProviderKinds.DefaultAzureContainer,
        p.GoogleClientId,
        p.GoogleClientSecret,
        p.GoogleRefreshToken,
        p.GoogleFolderId,
        p.UpdatedAt);

    private static StorageProviderDto ToDto(StorageProvider p, int shelfCount)
    {
        var hasConnectionString = !string.IsNullOrEmpty(p.AzureConnectionString);
        return new(
            Id: p.Id,
            Kind: p.Kind,
            Name: p.Name,
            Container: p.Kind == StorageProviderKinds.AzureBlob
                ? (p.AzureContainer is { Length: > 0 } c ? c : StorageProviderKinds.DefaultAzureContainer)
                : null,
            HasConnectionString: hasConnectionString,
            ConnectionStringHint: hasConnectionString ? SecretHint(p.AzureConnectionString!) : null,
            GoogleClientId: p.GoogleClientId,
            HasGoogleClientSecret: !string.IsNullOrEmpty(p.GoogleClientSecret),
            GoogleConnected: !string.IsNullOrEmpty(p.GoogleRefreshToken),
            ShelfCount: shelfCount,
            CreatedAt: p.CreatedAt,
            UpdatedAt: p.UpdatedAt);
    }

    /// <summary>Last four characters — enough to recognise a secret, useless to steal.</summary>
    private static string SecretHint(string secret) =>
        secret.Length <= 4 ? new string('*', secret.Length) : secret[^4..];
}

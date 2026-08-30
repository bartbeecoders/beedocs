using BeeDocs.Api.Models;
using Microsoft.Data.Sqlite;

namespace BeeDocs.Api.Services;

/// <summary>The three connection kinds, and the spellings a client may send.</summary>
public static class GitConnectionKinds
{
    public const string GitHub = "github";
    public const string AzureDevOps = "azure-devops";
    public const string Git = "git";

    public static readonly IReadOnlyList<string> All = [GitHub, AzureDevOps, Git];

    public static string? Normalize(string? raw) =>
        (raw ?? string.Empty).Trim().ToLowerInvariant().Replace(" ", "").Replace("-", "").Replace("_", "") switch
        {
            "github" => GitHub,
            "azuredevops" or "devops" or "ado" or "azure" => AzureDevOps,
            "git" or "url" or "generic" => Git,
            _ => null,
        };

    public static string DefaultName(string kind) => kind switch
    {
        GitHub => "GitHub",
        AzureDevOps => "Azure DevOps",
        Git => "Git repository",
        _ => kind,
    };
}

/// <summary>
/// A connection with its token attached, for authenticating one git or
/// provider-API call. Passed between services only — no endpoint returns this.
/// </summary>
public sealed record GitConnectionSecret(
    string Id,
    string Kind,
    string Name,
    string BaseUrl,
    string Username,
    string? Token
)
{
    /// <summary>
    /// The Basic-auth "user:password" for git's http.extraheader, or null when
    /// no token is stored (public repos, or an ambient credential helper).
    /// GitHub accepts any username with a PAT; DevOps ignores it too.
    /// </summary>
    public string? BasicAuth =>
        string.IsNullOrEmpty(Token)
            ? null
            : $"{(string.IsNullOrWhiteSpace(Username) ? "beedocs" : Username)}:{Token}";
}

public interface IGitConnectionService
{
    Task<IReadOnlyList<GitConnectionDto>> ListAsync(CancellationToken ct = default);
    Task<GitConnectionDto?> GetAsync(string id, CancellationToken ct = default);
    Task<GitConnectionDto> CreateAsync(CreateGitConnectionRequest request, CancellationToken ct = default);
    Task<GitConnectionDto?> UpdateAsync(string id, UpdateGitConnectionRequest request, CancellationToken ct = default);

    /// <summary>Refused (409 upstream) while repos still reference it.</summary>
    Task<bool> DeleteAsync(string id, CancellationToken ct = default);

    /// <summary>Load a connection together with its token. The only reader of the column.</summary>
    Task<GitConnectionSecret?> ResolveAsync(string id, CancellationToken ct = default);
}

/// <summary>
/// CRUD over <c>git_connection</c>, LlmProviderService to the letter: the token
/// column is selected in exactly one place (<see cref="ResolveAsync"/>) and
/// never reaches a DTO.
/// </summary>
public sealed class GitConnectionService(SqliteConnectionFactory db) : IGitConnectionService
{
    private const string SelectColumns =
        "id, kind, name, base_url, username, token, created_at, updated_at";

    public async Task<IReadOnlyList<GitConnectionDto>> ListAsync(CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = $"""
            SELECT {SelectColumns},
              (SELECT COUNT(*) FROM git_repo r WHERE r.connection_id = git_connection.id)
            FROM git_connection
            ORDER BY created_at
            """;

        var list = new List<GitConnectionDto>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
            list.Add(ToDto(ReadEntity(reader), reader.GetInt32(8)));
        return list;
    }

    public async Task<GitConnectionDto?> GetAsync(string id, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var row = await SelectAsync(conn, id, ct);
        return row is null ? null : ToDto(row, await CountReposAsync(conn, id, ct));
    }

    public async Task<GitConnectionDto> CreateAsync(
        CreateGitConnectionRequest request, CancellationToken ct = default)
    {
        var kind = GitConnectionKinds.Normalize(request.Kind)
            ?? throw new ArgumentException(
                $"Unknown connection kind '{request.Kind}'. Use one of: {string.Join(", ", GitConnectionKinds.All)}.");

        var now = DateTimeOffset.UtcNow;
        var row = new GitConnection
        {
            Id = SqliteHelpers.NewId(),
            Kind = kind,
            Name = string.IsNullOrWhiteSpace(request.Name)
                ? GitConnectionKinds.DefaultName(kind)
                : request.Name.Trim(),
            BaseUrl = NormalizeBaseUrl(request.BaseUrl, kind),
            Username = (request.Username ?? string.Empty).Trim(),
            Token = NormalizeToken(request.Token),
            CreatedAt = now,
            UpdatedAt = now,
        };

        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO git_connection (id, kind, name, base_url, username, token, created_at, updated_at)
            VALUES ($id, $kind, $name, $base_url, $username, $token, $created_at, $updated_at)
            """;
        SqliteHelpers.Add(cmd, "$id", row.Id);
        SqliteHelpers.Add(cmd, "$kind", row.Kind);
        SqliteHelpers.Add(cmd, "$name", row.Name);
        SqliteHelpers.Add(cmd, "$base_url", row.BaseUrl);
        SqliteHelpers.Add(cmd, "$username", row.Username);
        SqliteHelpers.Add(cmd, "$token", row.Token);
        SqliteHelpers.Add(cmd, "$created_at", SqliteHelpers.FormatTimestamp(row.CreatedAt));
        SqliteHelpers.Add(cmd, "$updated_at", SqliteHelpers.FormatTimestamp(row.UpdatedAt));
        await cmd.ExecuteNonQueryAsync(ct);
        return ToDto(row, 0);
    }

    public async Task<GitConnectionDto?> UpdateAsync(
        string id, UpdateGitConnectionRequest request, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var existing = await SelectAsync(conn, id, ct);
        if (existing is null) return null;

        if (!string.IsNullOrWhiteSpace(request.Name))
            existing.Name = request.Name.Trim();
        if (request.BaseUrl is not null)
            existing.BaseUrl = NormalizeBaseUrl(request.BaseUrl, existing.Kind);
        if (request.Username is not null)
            existing.Username = request.Username.Trim();
        // null leaves the stored token alone, "" clears it. Anything else replaces it.
        if (request.Token is not null)
            existing.Token = NormalizeToken(request.Token);

        existing.UpdatedAt = DateTimeOffset.UtcNow;

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            UPDATE git_connection SET name = $name, base_url = $base_url, username = $username,
              token = $token, updated_at = $updated_at
            WHERE id = $id
            """;
        SqliteHelpers.Add(cmd, "$id", existing.Id);
        SqliteHelpers.Add(cmd, "$name", existing.Name);
        SqliteHelpers.Add(cmd, "$base_url", existing.BaseUrl);
        SqliteHelpers.Add(cmd, "$username", existing.Username);
        SqliteHelpers.Add(cmd, "$token", existing.Token);
        SqliteHelpers.Add(cmd, "$updated_at", SqliteHelpers.FormatTimestamp(existing.UpdatedAt));
        await cmd.ExecuteNonQueryAsync(ct);
        return ToDto(existing, await CountReposAsync(conn, id, ct));
    }

    public async Task<bool> DeleteAsync(string id, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);

        var repos = await CountReposAsync(conn, id, ct);
        if (repos > 0)
        {
            throw new InvalidOperationException(
                $"This connection still has {repos} repositor{(repos == 1 ? "y" : "ies")} added. " +
                "Remove them first — deleting the connection would orphan their clones.");
        }

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "DELETE FROM git_connection WHERE id = $id";
        SqliteHelpers.Add(cmd, "$id", id);
        return await cmd.ExecuteNonQueryAsync(ct) > 0;
    }

    public async Task<GitConnectionSecret?> ResolveAsync(string id, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var row = await SelectAsync(conn, id, ct);
        return row is null
            ? null
            : new GitConnectionSecret(row.Id, row.Kind, row.Name, row.BaseUrl, row.Username, row.Token);
    }

    private static async Task<int> CountReposAsync(SqliteConnection conn, string id, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM git_repo WHERE connection_id = $id";
        SqliteHelpers.Add(cmd, "$id", id);
        return Convert.ToInt32(await cmd.ExecuteScalarAsync(ct));
    }

    private static async Task<GitConnection?> SelectAsync(
        SqliteConnection conn, string id, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = $"SELECT {SelectColumns} FROM git_connection WHERE id = $id LIMIT 1";
        SqliteHelpers.Add(cmd, "$id", id);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        return await reader.ReadAsync(ct) ? ReadEntity(reader) : null;
    }

    /// <summary>
    /// GitHub takes an org/user (a bare name or a github.com URL — the name is
    /// kept); DevOps takes the organization URL; the generic kind has none.
    /// </summary>
    private static string NormalizeBaseUrl(string? raw, string kind)
    {
        var value = (raw ?? string.Empty).Trim().TrimEnd('/');
        if (value.Length == 0) return string.Empty;

        if (kind == GitConnectionKinds.GitHub)
        {
            // Accept "myorg" or "https://github.com/myorg" — store the name.
            var name = value.Contains('/')
                ? value.Split('/', StringSplitOptions.RemoveEmptyEntries).Last()
                : value;
            if (name.Contains(' '))
                throw new ArgumentException($"'{raw}' is not a GitHub organization or user name.");
            return name;
        }

        if (kind == GitConnectionKinds.AzureDevOps)
        {
            if (!Uri.TryCreate(value, UriKind.Absolute, out var uri)
                || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
            {
                throw new ArgumentException(
                    $"'{raw}' must be the organization URL, e.g. https://dev.azure.com/my-org.");
            }
            return value;
        }

        return string.Empty;
    }

    private static string? NormalizeToken(string? raw) =>
        string.IsNullOrWhiteSpace(raw) ? null : raw.Trim();

    private static GitConnection ReadEntity(SqliteDataReader reader) => new()
    {
        Id = reader.GetString(0),
        Kind = reader.GetString(1),
        Name = reader.GetString(2),
        BaseUrl = reader.IsDBNull(3) ? string.Empty : reader.GetString(3),
        Username = reader.IsDBNull(4) ? string.Empty : reader.GetString(4),
        Token = SqliteHelpers.GetNullableString(reader, 5),
        CreatedAt = SqliteHelpers.ReadTimestamp(reader, 6),
        UpdatedAt = SqliteHelpers.ReadTimestamp(reader, 7),
    };

    private static GitConnectionDto ToDto(GitConnection c, int repoCount)
    {
        var hasToken = !string.IsNullOrEmpty(c.Token);
        return new(
            Id: c.Id,
            Kind: c.Kind,
            Name: c.Name,
            BaseUrl: c.BaseUrl,
            Username: c.Username,
            HasToken: hasToken,
            TokenHint: hasToken ? TokenHint(c.Token!) : null,
            RepoCount: repoCount,
            CreatedAt: c.CreatedAt,
            UpdatedAt: c.UpdatedAt);
    }

    /// <summary>Last four characters — enough to recognise a token, useless to steal.</summary>
    private static string TokenHint(string token) =>
        token.Length <= 4 ? new string('*', token.Length) : token[^4..];
}

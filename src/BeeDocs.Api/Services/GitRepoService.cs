using System.Security.Cryptography;
using System.Text;
using BeeDocs.Api.Models;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.Data.Sqlite;

namespace BeeDocs.Api.Services;

public interface IGitRepoService
{
    Task<IReadOnlyList<GitRepoDto>> ListAsync(CancellationToken ct = default);
    Task<GitRepoDto?> GetAsync(string id, CancellationToken ct = default);

    /// <summary>Insert the row and start the clone in the background; the row's
    /// status tells the story (cloning → ready | error).</summary>
    Task<GitRepoDto> AddAsync(string connectionId, AddGitRepoRequest request, CancellationToken ct = default);

    Task<GitRepoDto?> UpdateAsync(string id, UpdateGitRepoRequest request, CancellationToken ct = default);
    Task<bool> DeleteAsync(string id, CancellationToken ct = default);

    /// <summary>Pull --ff-only from the remote. Synchronous — the UI gives it a long timeout.</summary>
    Task<GitRepoDto> SyncAsync(string id, CancellationToken ct = default);

    Task<IReadOnlyList<GitTreeEntryDto>> TreeAsync(string id, string? path, CancellationToken ct = default);
    Task<GitFileDto> FileAsync(string id, string? path, CancellationToken ct = default);

    /// <summary>Absolute path + content type + download name for streaming one file.</summary>
    Task<(string AbsolutePath, string ContentType, string FileName)> RawAsync(
        string id, string? path, CancellationToken ct = default);

    Task<GitStatusDto> StatusAsync(string id, CancellationToken ct = default);
    Task<IReadOnlyList<GitBranchDto>> BranchesAsync(string id, CancellationToken ct = default);
}

/// <summary>
/// The repos someone put on the shelf: one row plus one clone each, under
/// <see cref="GitOptions.Root"/>/{repoId}. Everything a client sees of the
/// repo's *content* is read live from the clone — the row holds only management
/// state. File reads come from the working tree (phase 1 serves the current
/// checkout; ref-addressed reads arrive with history in a later phase), through
/// <see cref="GitPaths"/> so no client path escapes the clone.
/// </summary>
public sealed class GitRepoService(
    SqliteConnectionFactory db,
    GitCli git,
    GitOptions options,
    IGitConnectionService connections,
    GitSearchIndexer indexer,
    ILogger<GitRepoService> logger
) : IGitRepoService
{
    private const string SelectColumns =
        "r.id, r.connection_id, r.name, r.clone_url, r.default_branch, r.status, " +
        "r.last_error, r.indexed, r.fetched_at, r.created_at, r.updated_at, c.name, c.kind";

    private const string SelectSql =
        $"SELECT {SelectColumns} FROM git_repo r JOIN git_connection c ON c.id = r.connection_id";

    /// <summary>Inline text cap; past it the raw route still streams the file.</summary>
    private const long MaxInlineTextBytes = 2 * 1024 * 1024;

    private static readonly FileExtensionContentTypeProvider ContentTypes = new();

    public async Task<IReadOnlyList<GitRepoDto>> ListAsync(CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = SelectSql + " ORDER BY c.created_at, r.name";

        var list = new List<GitRepoDto>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
            list.Add(ReadDto(reader));
        return list;
    }

    public async Task<GitRepoDto?> GetAsync(string id, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        return await SelectAsync(conn, id, ct);
    }

    public async Task<GitRepoDto> AddAsync(
        string connectionId, AddGitRepoRequest request, CancellationToken ct = default)
    {
        var connection = await connections.ResolveAsync(connectionId, ct)
            ?? throw new KeyNotFoundException($"Connection '{connectionId}' not found.");

        var cloneUrl = (request.CloneUrl ?? string.Empty).Trim();
        if (!Uri.TryCreate(cloneUrl, UriKind.Absolute, out var uri)
            || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
        {
            // https only: it is what the PAT header authenticates, and what the
            // GitCli hardening assumes (no file://, no ssh key management).
            throw new ArgumentException($"'{request.CloneUrl}' must be an absolute http(s) clone URL.");
        }

        var name = (request.Name ?? string.Empty).Trim();
        if (name.Length == 0)
        {
            var last = uri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries).LastOrDefault() ?? "repo";
            name = last.EndsWith(".git", StringComparison.OrdinalIgnoreCase) ? last[..^4] : last;
            name = Uri.UnescapeDataString(name);
        }

        var now = DateTimeOffset.UtcNow;
        var repo = new GitRepo
        {
            Id = SqliteHelpers.NewId(),
            ConnectionId = connection.Id,
            Name = name,
            CloneUrl = cloneUrl,
            Status = "cloning",
            Indexed = request.Indexed ?? false,
            CreatedAt = now,
            UpdatedAt = now,
        };

        await using (var conn = await db.OpenConnectionAsync(ct))
        {
            await using var cmd = conn.CreateCommand();
            cmd.CommandText = """
                INSERT INTO git_repo (id, connection_id, name, clone_url, default_branch, status, indexed, created_at, updated_at)
                VALUES ($id, $connection_id, $name, $clone_url, '', 'cloning', $indexed, $created_at, $updated_at)
                """;
            SqliteHelpers.Add(cmd, "$id", repo.Id);
            SqliteHelpers.Add(cmd, "$connection_id", repo.ConnectionId);
            SqliteHelpers.Add(cmd, "$name", repo.Name);
            SqliteHelpers.Add(cmd, "$clone_url", repo.CloneUrl);
            SqliteHelpers.Add(cmd, "$indexed", repo.Indexed ? 1 : 0);
            SqliteHelpers.Add(cmd, "$created_at", SqliteHelpers.FormatTimestamp(repo.CreatedAt));
            SqliteHelpers.Add(cmd, "$updated_at", SqliteHelpers.FormatTimestamp(repo.UpdatedAt));
            await cmd.ExecuteNonQueryAsync(ct);
        }

        // Minutes-scale on a real repo, so it must not hold this request open.
        // Every dependency is a singleton and the outcome lands in the row,
        // which the UI polls while status == cloning.
        _ = Task.Run(() => CloneAsync(repo.Id, repo.CloneUrl, connection.BasicAuth), CancellationToken.None);

        return (await GetAsync(repo.Id, ct))!;
    }

    private async Task CloneAsync(string repoId, string cloneUrl, string? basicAuth)
    {
        var dir = RepoDir(repoId);
        try
        {
            using (await git.LockAsync(repoId, CancellationToken.None))
            {
                // A leftover directory from a failed earlier clone would make
                // git refuse; this id was just minted, so it can only be ours.
                if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);

                await git.RunOkAsync(
                    options.Root,
                    ["clone", "--no-recurse-submodules", cloneUrl, dir],
                    basicAuth, GitCli.CloneTimeout, CancellationToken.None);

                var branch = (await git.RunOkAsync(
                    dir, ["symbolic-ref", "--short", "HEAD"],
                    basicAuth: null, GitCli.ReadTimeout, CancellationToken.None)).Trim();

                await MarkAsync(repoId, "ready", null, branch, touchFetched: true, CancellationToken.None);
            }

            await IndexIfOptedInAsync(repoId, CancellationToken.None);
            logger.LogInformation("Cloned git repo {RepoId} from {Url}.", repoId, cloneUrl);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Clone of git repo {RepoId} failed.", repoId);
            var message = ex is GitException ? ex.Message : "Clone failed: " + ex.Message;
            try
            {
                await MarkAsync(repoId, "error", message, branch: null, touchFetched: false, CancellationToken.None);
            }
            catch (Exception mark)
            {
                logger.LogError(mark, "Could not record the clone failure for {RepoId}.", repoId);
            }
        }
    }

    public async Task<GitRepoDto?> UpdateAsync(
        string id, UpdateGitRepoRequest request, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var existing = await SelectAsync(conn, id, ct);
        if (existing is null) return null;

        var name = string.IsNullOrWhiteSpace(request.Name) ? existing.Name : request.Name.Trim();
        var indexed = request.Indexed ?? existing.Indexed;

        await using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = """
                UPDATE git_repo SET name = $name, indexed = $indexed, updated_at = $updated_at
                WHERE id = $id
                """;
            SqliteHelpers.Add(cmd, "$id", id);
            SqliteHelpers.Add(cmd, "$name", name);
            SqliteHelpers.Add(cmd, "$indexed", indexed ? 1 : 0);
            SqliteHelpers.Add(cmd, "$updated_at", SqliteHelpers.FormatTimestamp(DateTimeOffset.UtcNow));
            await cmd.ExecuteNonQueryAsync(ct);
        }

        if (indexed != existing.Indexed)
        {
            if (indexed && existing.Status == "ready")
                await indexer.IndexAsync(id, RepoDir(id), ct);
            else if (!indexed)
                await indexer.PurgeAsync(id, ct);
        }

        return await SelectAsync(conn, id, ct);
    }

    public async Task<bool> DeleteAsync(string id, CancellationToken ct = default)
    {
        await using (var conn = await db.OpenConnectionAsync(ct))
        {
            await using var cmd = conn.CreateCommand();
            cmd.CommandText = "DELETE FROM git_repo WHERE id = $id";
            SqliteHelpers.Add(cmd, "$id", id);
            if (await cmd.ExecuteNonQueryAsync(ct) == 0) return false;
        }

        await indexer.PurgeAsync(id, ct);

        // The clone goes after the row, attachment-style: a failed disk delete
        // leaves an orphan directory, not a row pointing at nothing.
        try
        {
            using (await git.LockAsync(id, ct))
            {
                var dir = RepoDir(id);
                if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
            }
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Could not delete the clone directory of git repo {RepoId}.", id);
        }

        return true;
    }

    public async Task<GitRepoDto> SyncAsync(string id, CancellationToken ct = default)
    {
        var repo = await RequireAsync(id, ct);
        if (repo.Status == "cloning")
            throw new GitException($"{repo.Name} is still cloning — try again in a moment.");

        var connection = await connections.ResolveAsync(repo.ConnectionId, ct)
            ?? throw new GitException($"The connection behind {repo.Name} no longer exists.");

        try
        {
            using (await git.LockAsync(id, ct))
            {
                // --ff-only: with a read-only working tree (phase 1) the pull is
                // always fast-forward; anything else means the remote rewrote
                // history, which a Sync button has no business papering over.
                await git.RunOkAsync(
                    RepoDir(id), ["pull", "--ff-only", "--no-recurse-submodules"],
                    connection.BasicAuth, GitCli.SyncTimeout, ct);
            }

            await MarkAsync(id, "ready", null, branch: null, touchFetched: true, ct);
            await IndexIfOptedInAsync(id, ct);
        }
        catch (GitException ex)
        {
            // The clone is still browsable — record the failure on the row and
            // let the caller show it, without downgrading status.
            await MarkAsync(id, repo.Status, ex.Message, branch: null, touchFetched: false, ct);
            throw;
        }

        return (await GetAsync(id, ct))!;
    }

    public async Task<IReadOnlyList<GitTreeEntryDto>> TreeAsync(
        string id, string? path, CancellationToken ct = default)
    {
        var repo = await RequireReadyAsync(id, ct);
        var relative = GitPaths.Normalize(path);
        var dir = GitPaths.Resolve(RepoDir(repo.Id), relative);
        if (!Directory.Exists(dir))
            throw new KeyNotFoundException($"'{relative}' is not a directory in {repo.Name}.");

        var entries = new List<GitTreeEntryDto>();
        foreach (var entry in Directory.EnumerateFileSystemEntries(dir))
        {
            var name = Path.GetFileName(entry);
            if (name.Equals(".git", StringComparison.OrdinalIgnoreCase)) continue;
            var info = new FileInfo(entry);
            if (info.LinkTarget is not null) continue;

            var childPath = relative.Length == 0 ? name : relative + "/" + name;
            entries.Add(Directory.Exists(entry)
                ? new GitTreeEntryDto(name, childPath, "dir", null)
                : new GitTreeEntryDto(name, childPath, "file", info.Length));
        }

        // Directories first, then files, each alphabetically — the tree order
        // every code host uses.
        entries.Sort(static (a, b) => a.Type != b.Type
            ? string.CompareOrdinal(a.Type, b.Type) // "dir" < "file"
            : string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase));
        return entries;
    }

    public async Task<GitFileDto> FileAsync(string id, string? path, CancellationToken ct = default)
    {
        var repo = await RequireReadyAsync(id, ct);
        var relative = GitPaths.Normalize(path);
        var absolute = GitPaths.Resolve(RepoDir(repo.Id), relative);
        var info = new FileInfo(absolute);
        if (!info.Exists)
            throw new KeyNotFoundException($"'{relative}' is not a file in {repo.Name}.");

        var name = Path.GetFileName(absolute);
        var bytes = await File.ReadAllBytesAsync(absolute, ct);
        var binary = LooksBinary(bytes);
        var tooLarge = !binary && bytes.LongLength > MaxInlineTextBytes;

        return new GitFileDto(
            Path: relative,
            Name: name,
            Binary: binary,
            Size: bytes.LongLength,
            BlobSha: BlobSha(bytes),
            Content: binary || tooLarge ? null : Encoding.UTF8.GetString(bytes),
            ContentBase64: null,
            TooLarge: tooLarge);
    }

    public async Task<(string AbsolutePath, string ContentType, string FileName)> RawAsync(
        string id, string? path, CancellationToken ct = default)
    {
        var repo = await RequireReadyAsync(id, ct);
        var relative = GitPaths.Normalize(path);
        var absolute = GitPaths.Resolve(RepoDir(repo.Id), relative);
        if (!File.Exists(absolute))
            throw new KeyNotFoundException($"'{relative}' is not a file in {repo.Name}.");

        var name = Path.GetFileName(absolute);
        var contentType = ContentTypes.TryGetContentType(name, out var known)
            ? known
            : "application/octet-stream";
        return (absolute, contentType, name);
    }

    public async Task<GitStatusDto> StatusAsync(string id, CancellationToken ct = default)
    {
        var repo = await RequireReadyAsync(id, ct);
        var output = await git.RunOkAsync(
            RepoDir(repo.Id), ["status", "--porcelain=v2", "--branch"],
            basicAuth: null, GitCli.ReadTimeout, ct);

        var branch = repo.DefaultBranch;
        var ahead = 0;
        var behind = 0;
        var dirty = new List<GitDirtyEntryDto>();

        foreach (var line in output.Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            if (line.StartsWith("# branch.head ", StringComparison.Ordinal))
            {
                branch = line["# branch.head ".Length..].Trim();
            }
            else if (line.StartsWith("# branch.ab ", StringComparison.Ordinal))
            {
                // "# branch.ab +1 -2"
                var parts = line["# branch.ab ".Length..].Split(' ', StringSplitOptions.RemoveEmptyEntries);
                foreach (var part in parts)
                {
                    if (part.StartsWith('+') && int.TryParse(part[1..], out var a)) ahead = a;
                    if (part.StartsWith('-') && int.TryParse(part[1..], out var b)) behind = b;
                }
            }
            else if (line.StartsWith("1 ", StringComparison.Ordinal)
                || line.StartsWith("2 ", StringComparison.Ordinal))
            {
                // porcelain v2: "1 XY sub mH mI mW hH hI path" — the path is
                // everything after the eighth space-separated field.
                var fields = line.Split(' ', 9);
                if (fields.Length == 9)
                    dirty.Add(new GitDirtyEntryDto(fields[8], fields[1].Trim('.')));
            }
            else if (line.StartsWith("? ", StringComparison.Ordinal))
            {
                dirty.Add(new GitDirtyEntryDto(line[2..], "untracked"));
            }
        }

        return new GitStatusDto(branch, ahead, behind, dirty);
    }

    public async Task<IReadOnlyList<GitBranchDto>> BranchesAsync(string id, CancellationToken ct = default)
    {
        var repo = await RequireReadyAsync(id, ct);
        var dir = RepoDir(repo.Id);

        var current = (await git.RunOkAsync(
            dir, ["symbolic-ref", "--short", "-q", "HEAD"],
            basicAuth: null, GitCli.ReadTimeout, ct)).Trim();

        var output = await git.RunOkAsync(
            dir, ["for-each-ref", "refs/heads", "--format=%(refname:short)"],
            basicAuth: null, GitCli.ReadTimeout, ct);

        return output.Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(name => name.Trim())
            .Where(name => name.Length > 0)
            .Select(name => new GitBranchDto(name, name == current))
            .ToList();
    }

    // -------------------------------------------------------------------------

    private string RepoDir(string repoId) => Path.Combine(options.Root, repoId);

    private async Task IndexIfOptedInAsync(string repoId, CancellationToken ct)
    {
        var repo = await GetAsync(repoId, ct);
        if (repo is not { Indexed: true, Status: "ready" }) return;
        try
        {
            await indexer.IndexAsync(repoId, RepoDir(repoId), ct);
        }
        catch (Exception ex)
        {
            // Search is a convenience; a failed walk must not fail the sync.
            logger.LogWarning(ex, "Search indexing of git repo {RepoId} failed.", repoId);
        }
    }

    private async Task<GitRepoDto> RequireAsync(string id, CancellationToken ct)
    {
        return await GetAsync(id, ct)
            ?? throw new KeyNotFoundException($"Repository '{id}' not found.");
    }

    private async Task<GitRepoDto> RequireReadyAsync(string id, CancellationToken ct)
    {
        var repo = await RequireAsync(id, ct);
        return repo.Status switch
        {
            "ready" => repo,
            "cloning" => throw new GitException($"{repo.Name} is still cloning — try again in a moment."),
            _ => throw new GitException(
                $"{repo.Name} is not available: {repo.LastError ?? "the clone failed"}. " +
                "Fix the connection and use Sync, or remove and re-add the repository."),
        };
    }

    private async Task MarkAsync(
        string id, string status, string? error, string? branch, bool touchFetched, CancellationToken ct)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = $"""
            UPDATE git_repo SET status = $status, last_error = $error,
              default_branch = COALESCE($branch, default_branch),
              fetched_at = {(touchFetched ? "$now" : "fetched_at")},
              updated_at = $now
            WHERE id = $id
            """;
        SqliteHelpers.Add(cmd, "$id", id);
        SqliteHelpers.Add(cmd, "$status", status);
        SqliteHelpers.Add(cmd, "$error", error);
        SqliteHelpers.Add(cmd, "$branch", branch);
        SqliteHelpers.Add(cmd, "$now", SqliteHelpers.FormatTimestamp(DateTimeOffset.UtcNow));
        await cmd.ExecuteNonQueryAsync(ct);
    }

    private async Task<GitRepoDto?> SelectAsync(SqliteConnection conn, string id, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = SelectSql + " WHERE r.id = $id LIMIT 1";
        SqliteHelpers.Add(cmd, "$id", id);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        return await reader.ReadAsync(ct) ? ReadDto(reader) : null;
    }

    private static GitRepoDto ReadDto(SqliteDataReader reader) => new(
        Id: reader.GetString(0),
        ConnectionId: reader.GetString(1),
        Name: reader.GetString(2),
        CloneUrl: reader.GetString(3),
        DefaultBranch: reader.IsDBNull(4) ? string.Empty : reader.GetString(4),
        Status: reader.GetString(5),
        LastError: SqliteHelpers.GetNullableString(reader, 6),
        Indexed: !reader.IsDBNull(7) && reader.GetInt64(7) != 0,
        FetchedAt: SqliteHelpers.GetNullableString(reader, 8) is { } fetched
            && DateTimeOffset.TryParse(fetched, out var parsed) ? parsed : null,
        CreatedAt: SqliteHelpers.ReadTimestamp(reader, 9),
        UpdatedAt: SqliteHelpers.ReadTimestamp(reader, 10),
        ConnectionName: reader.GetString(11),
        ConnectionKind: reader.GetString(12));

    /// <summary>NUL in the first 8000 bytes — the same heuristic git itself uses.</summary>
    private static bool LooksBinary(byte[] bytes)
    {
        var probe = Math.Min(bytes.Length, 8000);
        for (var i = 0; i < probe; i++)
        {
            if (bytes[i] == 0) return true;
        }
        return false;
    }

    /// <summary>
    /// The git blob id of these bytes (SHA-1 of "blob {len}\0" + content),
    /// computed in-process — it is the optimistic-concurrency handle later
    /// phases compare on save, and spawning git for every read would be silly.
    /// </summary>
    private static string BlobSha(byte[] bytes)
    {
        var header = Encoding.ASCII.GetBytes($"blob {bytes.Length}\0");
        var buffer = new byte[header.Length + bytes.Length];
        header.CopyTo(buffer, 0);
        bytes.CopyTo(buffer, header.Length);
        return Convert.ToHexStringLower(SHA1.HashData(buffer));
    }
}

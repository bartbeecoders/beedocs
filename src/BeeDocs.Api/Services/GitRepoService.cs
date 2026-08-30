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

    /// <summary>Pull from the remote (merge; a conflict is backed out and reported as 409,
    /// unless <paramref name="strategy"/> — ours|theirs — says which side wins).
    /// Synchronous — the UI gives it a long timeout.</summary>
    Task<GitRepoDto> SyncAsync(string id, string? strategy = null, CancellationToken ct = default);

    Task<IReadOnlyList<GitTreeEntryDto>> TreeAsync(string id, string? path, CancellationToken ct = default);

    /// <summary>The working-tree file, or — when <paramref name="gitRef"/> names a commit/branch —
    /// that ref's version of it (text only; read-only history view).</summary>
    Task<GitFileDto> FileAsync(string id, string? path, string? gitRef = null, CancellationToken ct = default);

    /// <summary>Save to the working tree, guarded by the blob sha the editor loaded.</summary>
    Task<GitFileDto> WriteFileAsync(string id, string? path, GitWriteFileRequest request, CancellationToken ct = default);

    /// <summary>Stage and commit; author = the acting account's name + git email.</summary>
    Task<GitCommitResultDto> CommitAsync(string id, GitCommitRequest request, CancellationToken ct = default);

    /// <summary>Push the current branch. Never forces — non-fast-forward is a 409 "pull first".</summary>
    Task<GitStatusDto> PushAsync(string id, CancellationToken ct = default);

    /// <summary>Switch branches. Refused (409) while the shared working copy is dirty.</summary>
    Task<GitRepoDto> CheckoutAsync(string id, string branch, CancellationToken ct = default);

    Task<GitRepoDto> CreateBranchAsync(string id, GitCreateBranchRequest request, CancellationToken ct = default);

    /// <summary>Commit history, newest first — the whole branch or one path's.</summary>
    Task<IReadOnlyList<GitLogEntryDto>> LogAsync(string id, string? path, int limit, CancellationToken ct = default);

    /// <summary>One commit with its patch (optionally narrowed to a path).</summary>
    Task<GitCommitDetailDto> CommitDetailAsync(string id, string sha, string? path, CancellationToken ct = default);

    /// <summary>Uncommitted changes against HEAD — the whole tree or one path (untracked included per-path).</summary>
    Task<GitDiffDto> DiffAsync(string id, string? path, CancellationToken ct = default);

    /// <summary>Delete a working-tree file. The deletion shows as dirty until committed.</summary>
    Task DeleteFileAsync(string id, string? path, CancellationToken ct = default);

    /// <summary>Move/rename a working-tree file or folder inside the repo.</summary>
    Task RenameAsync(string id, GitRenameRequest request, CancellationToken ct = default);

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
    ICurrentUserAccessor currentUser,
    IUserService users,
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

    public async Task<GitRepoDto> SyncAsync(
        string id, string? strategy = null, CancellationToken ct = default)
    {
        var repo = await RequireAsync(id, ct);
        if (repo.Status == "cloning")
            throw new GitException($"{repo.Name} is still cloning — try again in a moment.");

        var chosen = (strategy ?? string.Empty).Trim().ToLowerInvariant();
        if (chosen is not ("" or "ours" or "theirs"))
            throw new ArgumentException($"Unknown pull strategy '{strategy}'. Use ours or theirs.");

        var connection = await connections.ResolveAsync(repo.ConnectionId, ct)
            ?? throw new GitException($"The connection behind {repo.Name} no longer exists.");

        try
        {
            using (await git.LockAsync(id, ct))
            {
                // -X ours/-X theirs resolves *conflicting hunks* toward one side
                // and merges the rest normally — the "keep mine / take theirs"
                // answer to a pull that 409ed on a conflict.
                // The identity pins the *merge commit* a pull can create — left
                // unset, git would sign it with whatever global config the host
                // machine happens to carry.
                var args = new List<string>
                {
                    "-c", "user.name=BeeDocs",
                    "-c", "user.email=beedocs@beedocs.local",
                    "pull", "--no-rebase", "--no-recurse-submodules",
                };
                if (chosen.Length > 0)
                {
                    args.Add("-X");
                    args.Add(chosen);
                }
                var pull = await git.RunAsync(
                    RepoDir(id), args, connection.BasicAuth, GitCli.SyncTimeout, ct);
                if (pull.ExitCode != 0)
                {
                    // A conflicted merge leaves the shared tree half-merged. Back
                    // it out first, then say which files collided — leaving
                    // conflict markers in a tree other people are reading is the
                    // one thing a failed pull must never do.
                    var conflicted = await git.RunAsync(
                        RepoDir(id), ["diff", "--name-only", "--diff-filter=U"],
                        basicAuth: null, GitCli.ReadTimeout, ct);
                    var files = conflicted.StdOut.Split('\n', StringSplitOptions.RemoveEmptyEntries);
                    if (files.Length > 0)
                    {
                        await git.RunAsync(
                            RepoDir(id), ["merge", "--abort"],
                            basicAuth: null, GitCli.ReadTimeout, ct);
                        throw new GitConflictException(
                            $"Pull would conflict in {string.Join(", ", files.Take(5))}" +
                            $"{(files.Length > 5 ? $" and {files.Length - 5} more" : "")}. " +
                            "The merge was backed out: both sides changed the same lines. Pull " +
                            "again keeping ours or taking theirs, or undo one side and retry.");
                    }

                    var detail = pull.StdErr + "\n" + pull.StdOut;
                    if (detail.Contains("would be overwritten", StringComparison.OrdinalIgnoreCase))
                    {
                        throw new GitConflictException(
                            "Pull refused: uncommitted changes in the shared working copy would be " +
                            "overwritten. Commit them first, then pull again.");
                    }

                    throw new GitException(GitCli.Describe(args, pull));
                }
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

    public async Task<GitFileDto> FileAsync(
        string id, string? path, string? gitRef = null, CancellationToken ct = default)
    {
        var repo = await RequireReadyAsync(id, ct);
        var relative = GitPaths.Normalize(path);

        if (!string.IsNullOrWhiteSpace(gitRef))
            return await FileAtRefAsync(repo, relative, gitRef, ct);

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

    /// <summary>
    /// The ref's version of a file, read through plumbing so nothing touches the
    /// working tree. Text only: history views render prose and code; a binary at
    /// an old ref answers with no content rather than garbled bytes.
    /// </summary>
    private async Task<GitFileDto> FileAtRefAsync(
        GitRepoDto repo, string relative, string gitRef, CancellationToken ct)
    {
        var reference = ValidateRef(gitRef);
        var dir = RepoDir(repo.Id);

        var blob = await git.RunAsync(
            dir, ["rev-parse", "--verify", "--quiet", $"{reference}:{relative}"],
            basicAuth: null, GitCli.ReadTimeout, ct);
        if (blob.ExitCode != 0)
            throw new KeyNotFoundException($"'{relative}' does not exist at {gitRef} in {repo.Name}.");

        var show = await git.RunOkAsync(
            dir, ["show", $"{reference}:{relative}"], basicAuth: null, GitCli.ReadTimeout, ct);
        var binary = show.Contains('\0');
        var tooLarge = !binary && show.Length > MaxInlineTextBytes;

        return new GitFileDto(
            Path: relative,
            Name: Path.GetFileName(relative),
            Binary: binary,
            Size: show.Length,
            BlobSha: blob.StdOut.Trim(),
            Content: binary || tooLarge ? null : show,
            ContentBase64: null,
            TooLarge: tooLarge);
    }

    /// <summary>
    /// A ref a client may name: a branch, sha, or relative spec like HEAD~2.
    /// Charset-limited and never starting with '-', so it can only ever be a
    /// value on a git command line; ".." is refused because a range would turn
    /// `show` into something else entirely.
    /// </summary>
    private static string ValidateRef(string raw)
    {
        var reference = raw.Trim();
        if (reference.Length is 0 or > 120
            || reference[0] is '-' or '.'
            || reference.Contains("..", StringComparison.Ordinal)
            || reference.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not ('.' or '_' or '/' or '~' or '^' or '-')))
        {
            throw new ArgumentException($"'{raw}' is not a usable git ref.");
        }

        return reference;
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

    public async Task<GitFileDto> WriteFileAsync(
        string id, string? path, GitWriteFileRequest request, CancellationToken ct = default)
    {
        var repo = await RequireReadyAsync(id, ct);
        var relative = GitPaths.Normalize(path);
        if (relative.Length == 0)
            throw new ArgumentException("A file path is required.");

        using (await git.LockAsync(id, ct))
        {
            var absolute = GitPaths.Resolve(RepoDir(repo.Id), relative);
            if (Directory.Exists(absolute))
                throw new ArgumentException($"'{relative}' is a directory.");

            // The guard that makes the shared working copy honest: the save only
            // lands on the exact bytes the editor loaded. baseBlobSha empty means
            // "I am creating this file", which its own existence can invalidate.
            var exists = File.Exists(absolute);
            var baseSha = (request.BaseBlobSha ?? string.Empty).Trim();
            if (exists)
            {
                if (baseSha.Length == 0)
                {
                    throw new GitConflictException(
                        $"'{relative}' already exists — open and edit it rather than creating over it.");
                }

                var current = BlobSha(await File.ReadAllBytesAsync(absolute, ct));
                if (!current.Equals(baseSha, StringComparison.OrdinalIgnoreCase))
                {
                    throw new GitConflictException(
                        $"'{relative}' changed on the server since you loaded it — someone saved, " +
                        "or a pull rewrote it. Reload the file and reapply your edit.");
                }
            }
            else if (baseSha.Length > 0)
            {
                throw new GitConflictException(
                    $"'{relative}' no longer exists on the server — it was deleted or renamed. " +
                    "Reload the repository tree.");
            }

            var directory = Path.GetDirectoryName(absolute)!;
            Directory.CreateDirectory(directory);

            // Sibling temp + move: a crash mid-write must never leave a torn
            // file where readers (and the next commit) will find it.
            var temp = Path.Combine(directory, $".beedocs-{Guid.NewGuid():N}.tmp");
            try
            {
                await File.WriteAllBytesAsync(temp, Encoding.UTF8.GetBytes(request.Content), ct);
                File.Move(temp, absolute, overwrite: true);
            }
            finally
            {
                if (File.Exists(temp)) File.Delete(temp);
            }
        }

        return await FileAsync(id, relative, gitRef: null, ct);
    }

    public async Task<GitCommitResultDto> CommitAsync(
        string id, GitCommitRequest request, CancellationToken ct = default)
    {
        var repo = await RequireReadyAsync(id, ct);
        var message = (request.Message ?? string.Empty).Trim();
        if (message.Length == 0)
            throw new ArgumentException("A commit message is required.");

        // Resolved before the lock: "set your git email first" must not queue
        // behind a running pull to be said.
        var (authorName, authorEmail) = await ResolveAuthorAsync(request, ct);

        string sha;
        using (await git.LockAsync(id, ct))
        {
            var dir = RepoDir(repo.Id);
            if (request.Paths is { Count: > 0 } paths)
            {
                var add = new List<string> { "add", "--" };
                foreach (var p in paths)
                {
                    var rel = GitPaths.Normalize(p);
                    if (rel.Length == 0)
                        throw new ArgumentException("An empty path cannot be committed.");
                    // Jail check only — the file may legitimately be a deletion.
                    GitPaths.Resolve(dir, rel);
                    add.Add(rel);
                }
                await git.RunOkAsync(dir, add, basicAuth: null, GitCli.ReadTimeout, ct);
            }
            else
            {
                await git.RunOkAsync(dir, ["add", "-A"], basicAuth: null, GitCli.ReadTimeout, ct);
            }

            var staged = await git.RunAsync(
                dir, ["diff", "--cached", "--quiet"], basicAuth: null, GitCli.ReadTimeout, ct);
            if (staged.ExitCode == 0)
                throw new GitException("Nothing to commit — the selected files match the last commit.");

            // Author = the person (their chosen git email); committer = BeeDocs,
            // so history reads "written by X, recorded by the platform".
            await git.RunOkAsync(
                dir,
                [
                    "-c", "user.name=BeeDocs",
                    "-c", "user.email=beedocs@beedocs.local",
                    "commit", "-m", message, $"--author={authorName} <{authorEmail}>",
                ],
                basicAuth: null, GitCli.ReadTimeout, ct);

            sha = (await git.RunOkAsync(
                dir, ["rev-parse", "HEAD"], basicAuth: null, GitCli.ReadTimeout, ct)).Trim();
        }

        await IndexIfOptedInAsync(id, ct);
        logger.LogInformation("Committed {Sha} to git repo {RepoId} as {Author}.", sha, id, authorName);
        return new GitCommitResultDto(sha, $"{authorName} <{authorEmail}>", await StatusAsync(id, ct));
    }

    public async Task<GitStatusDto> PushAsync(string id, CancellationToken ct = default)
    {
        var repo = await RequireReadyAsync(id, ct);
        var connection = await connections.ResolveAsync(repo.ConnectionId, ct)
            ?? throw new GitException($"The connection behind {repo.Name} no longer exists.");

        using (await git.LockAsync(id, ct))
        {
            // -u wires tracking on the first push of a new branch, so
            // ahead/behind keeps meaning something afterwards. Never --force:
            // rewriting a shared remote is not a button.
            var args = new[] { "push", "-u", "origin", "HEAD" };
            var result = await git.RunAsync(
                RepoDir(id), args, connection.BasicAuth, GitCli.SyncTimeout, ct);
            if (result.ExitCode != 0)
            {
                var detail = result.StdErr + "\n" + result.StdOut;
                if (detail.Contains("non-fast-forward", StringComparison.OrdinalIgnoreCase)
                    || detail.Contains("fetch first", StringComparison.OrdinalIgnoreCase)
                    || detail.Contains("[rejected]", StringComparison.OrdinalIgnoreCase))
                {
                    throw new GitConflictException(
                        "The remote has commits this server does not. Pull first, then push again.");
                }

                throw new GitException(GitCli.Describe(args, result));
            }
        }

        return await StatusAsync(id, ct);
    }

    public async Task<GitRepoDto> CheckoutAsync(string id, string branch, CancellationToken ct = default)
    {
        var repo = await RequireReadyAsync(id, ct);
        var name = await ValidateBranchNameAsync(repo.Id, branch, ct);

        using (await git.LockAsync(id, ct))
        {
            var dir = RepoDir(repo.Id);

            // The working copy is shared: switching branches under someone
            // else's uncommitted edit would carry it silently onto another
            // branch — or refuse halfway. All-or-nothing is the honest rule.
            var status = await git.RunAsync(
                dir, ["status", "--porcelain"], basicAuth: null, GitCli.ReadTimeout, ct);
            if (status.StdOut.Trim().Length > 0)
            {
                throw new GitConflictException(
                    "The working copy has uncommitted changes, and it is shared by everyone on " +
                    "this server. Commit them (or remove them) before switching branches.");
            }

            // Plain checkout DWIMs an origin/<name> into a local tracking branch.
            await git.RunOkAsync(dir, ["checkout", name], basicAuth: null, GitCli.ReadTimeout, ct);
            await MarkAsync(id, "ready", null, branch: name, touchFetched: false, ct);
        }

        // The tree content just changed wholesale — the index must follow.
        await IndexIfOptedInAsync(id, ct);
        return (await GetAsync(id, ct))!;
    }

    public async Task<GitRepoDto> CreateBranchAsync(
        string id, GitCreateBranchRequest request, CancellationToken ct = default)
    {
        var repo = await RequireReadyAsync(id, ct);
        var name = await ValidateBranchNameAsync(repo.Id, request.Name, ct);
        var checkout = request.Checkout ?? true;

        using (await git.LockAsync(id, ct))
        {
            var dir = RepoDir(repo.Id);
            // Branching with a dirty tree is allowed on purpose — the pending
            // edit rides onto the new branch, which is exactly how you take an
            // accidental main edit somewhere safe.
            await git.RunOkAsync(
                dir,
                checkout ? ["checkout", "-b", name] : ["branch", name],
                basicAuth: null, GitCli.ReadTimeout, ct);
            if (checkout)
                await MarkAsync(id, "ready", null, branch: name, touchFetched: false, ct);
        }

        return (await GetAsync(id, ct))!;
    }

    /// <summary>Record separators for machine-parsing log output — no content can contain them.</summary>
    private const char FieldSep = '\x1f';
    private const char RecordSep = '\x1e';

    /// <summary>Patches are for reading in a panel, not mirroring a monorepo change.</summary>
    private const int MaxPatchChars = 256 * 1024;

    public async Task<IReadOnlyList<GitLogEntryDto>> LogAsync(
        string id, string? path, int limit, CancellationToken ct = default)
    {
        var repo = await RequireReadyAsync(id, ct);
        var relative = GitPaths.Normalize(path);
        var count = Math.Clamp(limit, 1, 200);

        var args = new List<string>
        {
            "log", $"-n{count}", $"--format=%H{FieldSep}%an{FieldSep}%ae{FieldSep}%aI{FieldSep}%s{RecordSep}",
        };
        if (relative.Length > 0)
        {
            // --follow: a file's history survives its renames, which is exactly
            // what a "history of this page" view means.
            args.Add("--follow");
            args.Add("--");
            args.Add(relative);
        }

        var output = await git.RunOkAsync(
            RepoDir(repo.Id), args, basicAuth: null, GitCli.ReadTimeout, ct);

        var entries = new List<GitLogEntryDto>();
        foreach (var record in output.Split(RecordSep, StringSplitOptions.RemoveEmptyEntries))
        {
            var fields = record.Trim('\n').Split(FieldSep);
            if (fields.Length < 5) continue;
            entries.Add(new GitLogEntryDto(
                Sha: fields[0],
                ShortSha: fields[0].Length >= 8 ? fields[0][..8] : fields[0],
                Author: fields[1],
                AuthorEmail: fields[2],
                Date: DateTimeOffset.TryParse(fields[3], out var date) ? date : DateTimeOffset.UnixEpoch,
                Subject: fields[4]));
        }

        return entries;
    }

    public async Task<GitCommitDetailDto> CommitDetailAsync(
        string id, string sha, string? path, CancellationToken ct = default)
    {
        var repo = await RequireReadyAsync(id, ct);
        var reference = ValidateRef(sha);
        var relative = GitPaths.Normalize(path);
        var dir = RepoDir(repo.Id);

        var meta = await git.RunAsync(
            dir,
            ["log", "-n1", $"--format=%H{FieldSep}%an{FieldSep}%ae{FieldSep}%aI{FieldSep}%s{FieldSep}%b", reference],
            basicAuth: null, GitCli.ReadTimeout, ct);
        if (meta.ExitCode != 0)
            throw new KeyNotFoundException($"'{sha}' is not a commit in {repo.Name}.");

        var fields = meta.StdOut.TrimEnd('\n').Split(FieldSep);
        if (fields.Length < 5)
            throw new GitException($"Could not read commit '{sha}'.");

        var patchArgs = new List<string> { "show", "--format=", "--patch", reference };
        if (relative.Length > 0)
        {
            patchArgs.Add("--");
            patchArgs.Add(relative);
        }
        var patch = await git.RunOkAsync(dir, patchArgs, basicAuth: null, GitCli.ReadTimeout, ct);
        var truncated = patch.Length > MaxPatchChars;
        if (truncated) patch = patch[..MaxPatchChars];

        return new GitCommitDetailDto(
            Sha: fields[0],
            ShortSha: fields[0].Length >= 8 ? fields[0][..8] : fields[0],
            Author: fields[1],
            AuthorEmail: fields[2],
            Date: DateTimeOffset.TryParse(fields[3], out var date) ? date : DateTimeOffset.UnixEpoch,
            Subject: fields[4],
            Body: fields.Length > 5 ? string.Join(FieldSep, fields[5..]).Trim() : string.Empty,
            Patch: patch,
            PatchTruncated: truncated);
    }

    public async Task<GitDiffDto> DiffAsync(string id, string? path, CancellationToken ct = default)
    {
        var repo = await RequireReadyAsync(id, ct);
        var relative = GitPaths.Normalize(path);
        var dir = RepoDir(repo.Id);

        string patch;
        if (relative.Length > 0)
        {
            var absolute = GitPaths.Resolve(dir, relative);
            var tracked = await git.RunAsync(
                dir, ["ls-files", "--error-unmatch", "--", relative],
                basicAuth: null, GitCli.ReadTimeout, ct);
            if (tracked.ExitCode != 0 && File.Exists(absolute))
            {
                // Untracked: `diff HEAD` says nothing about it, but "what would
                // this commit add" has an obvious answer — the whole file.
                // --no-index exits 1 when the sides differ; that is success here.
                var noIndex = await git.RunAsync(
                    dir, ["diff", "--no-index", "--", "/dev/null", relative],
                    basicAuth: null, GitCli.ReadTimeout, ct);
                patch = noIndex.StdOut;
            }
            else
            {
                patch = await git.RunOkAsync(
                    dir, ["diff", "HEAD", "--", relative],
                    basicAuth: null, GitCli.ReadTimeout, ct);
            }
        }
        else
        {
            patch = await git.RunOkAsync(
                dir, ["diff", "HEAD"], basicAuth: null, GitCli.ReadTimeout, ct);
        }

        var truncated = patch.Length > MaxPatchChars;
        if (truncated) patch = patch[..MaxPatchChars];
        return new GitDiffDto(relative.Length > 0 ? relative : null, patch, truncated);
    }

    public async Task DeleteFileAsync(string id, string? path, CancellationToken ct = default)
    {
        var repo = await RequireReadyAsync(id, ct);
        var relative = GitPaths.Normalize(path);
        if (relative.Length == 0)
            throw new ArgumentException("A file path is required.");

        using (await git.LockAsync(id, ct))
        {
            var absolute = GitPaths.Resolve(RepoDir(repo.Id), relative);
            if (Directory.Exists(absolute))
                throw new ArgumentException($"'{relative}' is a folder — delete its files instead.");
            if (!File.Exists(absolute))
                throw new KeyNotFoundException($"'{relative}' is not a file in {repo.Name}.");
            // Working-tree only: the deletion shows as dirty and is undone by
            // committing nothing — git still has the committed version.
            File.Delete(absolute);
        }
    }

    public async Task RenameAsync(string id, GitRenameRequest request, CancellationToken ct = default)
    {
        var repo = await RequireReadyAsync(id, ct);
        var from = GitPaths.Normalize(request.From);
        var to = GitPaths.Normalize(request.To);
        if (from.Length == 0 || to.Length == 0)
            throw new ArgumentException("Both the current and the new path are required.");
        if (from == to) return;

        using (await git.LockAsync(id, ct))
        {
            var dir = RepoDir(repo.Id);
            var source = GitPaths.Resolve(dir, from);
            var target = GitPaths.Resolve(dir, to);
            if (File.Exists(target) || Directory.Exists(target))
                throw new GitConflictException($"'{to}' already exists.");

            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            if (File.Exists(source))
                File.Move(source, target);
            else if (Directory.Exists(source))
                Directory.Move(source, target);
            else
                throw new KeyNotFoundException($"'{from}' does not exist in {repo.Name}.");
        }
    }

    /// <summary>
    /// git's own <c>check-ref-format --branch</c> is the authority on names; the
    /// leading-dash check is ours, because a name like <c>-f</c> must never reach
    /// any git command line even as a value.
    /// </summary>
    private async Task<string> ValidateBranchNameAsync(string repoId, string? branch, CancellationToken ct)
    {
        var name = (branch ?? string.Empty).Trim();
        if (name.Length == 0 || name.StartsWith('-'))
            throw new ArgumentException($"'{branch}' is not a valid branch name.");

        var check = await git.RunAsync(
            RepoDir(repoId), ["check-ref-format", "--branch", name],
            basicAuth: null, GitCli.ReadTimeout, ct);
        if (check.ExitCode != 0)
            throw new ArgumentException($"'{branch}' is not a valid branch name.");
        return name;
    }

    public async Task<GitStatusDto> StatusAsync(string id, CancellationToken ct = default)
    {
        var repo = await RequireReadyAsync(id, ct);
        // -uall: untracked *files*, not collapsed directories — the commit
        // dialog's checklist has to name what would actually be committed.
        var output = await git.RunOkAsync(
            RepoDir(repo.Id), ["status", "--porcelain=v2", "--branch", "-uall"],
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

        // Remote-tracking refs too: a branch a colleague pushed is something a
        // reader wants to switch to, and checkout DWIMs it into a local one.
        var output = await git.RunOkAsync(
            dir, ["for-each-ref", "refs/heads", "refs/remotes/origin", "--format=%(refname:short)"],
            basicAuth: null, GitCli.ReadTimeout, ct);

        var locals = new List<string>();
        var remotes = new List<string>();
        foreach (var raw in output.Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            var name = raw.Trim();
            if (name.Length == 0) continue;
            if (name.StartsWith("origin/", StringComparison.Ordinal))
                remotes.Add(name["origin/".Length..]);
            else if (name != "origin") // refs/remotes/origin/HEAD shortens to "origin"
                locals.Add(name);
        }

        var branches = locals
            .Select(name => new GitBranchDto(name, name == current))
            .ToList();
        branches.AddRange(remotes
            .Where(name => !locals.Contains(name))
            .Select(name => new GitBranchDto(name, Current: false, IsRemote: true)));
        return branches;
    }

    // -------------------------------------------------------------------------

    private string RepoDir(string repoId) => Path.Combine(options.Root, repoId);

    /// <summary>
    /// Who a commit is authored as. A signed-in account must have set its own
    /// git email (Settings → Your account) — commits carry the name into git
    /// history, so guessing one is worse than refusing. A machine caller (the
    /// API key / MCP) or an open instance commits as the platform, unless the
    /// request names who the machine acts on behalf of; a person's identity is
    /// their own, so for them those fields are ignored.
    /// </summary>
    private async Task<(string Name, string Email)> ResolveAuthorAsync(
        GitCommitRequest request, CancellationToken ct)
    {
        var actor = currentUser.Current;
        if (actor.Id is null)
        {
            var declaredName = (request.AuthorName ?? string.Empty).Trim();
            var declaredEmail = (request.AuthorEmail ?? string.Empty).Trim();
            if (declaredEmail.Length > 0
                && (!declaredEmail.Contains('@') || declaredEmail.Contains(' ') || declaredEmail.Contains('>')))
            {
                throw new ArgumentException($"'{declaredEmail}' is not a usable git author email.");
            }

            return (
                declaredName.Length > 0
                    ? declaredName.Replace("<", "").Replace(">", "")
                    : "BeeDocs",
                declaredEmail.Length > 0 ? declaredEmail : "beedocs@beedocs.local");
        }

        var user = await users.GetAsync(actor.Id, ct);
        var email = user?.GitEmail?.Trim();
        if (string.IsNullOrEmpty(email))
        {
            throw new GitException(
                "Your account has no git email yet, and a commit writes your identity into git " +
                "history. Set one under Settings → Your account, then commit again.");
        }

        var name = string.IsNullOrWhiteSpace(user!.DisplayName) ? user.Username : user.DisplayName!;
        // Angle brackets would corrupt the "Name <email>" author syntax.
        return (name.Replace("<", "").Replace(">", "").Trim(), email);
    }

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

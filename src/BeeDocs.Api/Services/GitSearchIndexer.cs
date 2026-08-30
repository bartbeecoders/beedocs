using Microsoft.Data.Sqlite;

namespace BeeDocs.Api.Services;

/// <summary>
/// Feeds an opted-in repo's text files into Ctrl+K search as
/// <c>search_doc</c> rows of kind <c>gitfile</c>, entity id
/// <c>{repoId}:{path}</c>. Writes go straight to <c>search_doc</c> — never
/// through <c>search_queue</c>, whose drain reads an unknown kind as a delete —
/// and the FTS triggers on that table keep <c>search_fts</c> in step either
/// way. Rebuilt whole per sync (delete the repo's rows, insert the walk), so
/// renames need no detection; Reconcile leaves the kind alone because it only
/// enumerates the kinds it knows.
/// </summary>
public sealed class GitSearchIndexer(SqliteConnectionFactory db, ILogger<GitSearchIndexer> logger)
{
    public const string Kind = "gitfile";

    /// <summary>Caps: search is a convenience, not a mirror of a monorepo.</summary>
    private const long MaxFileBytes = 512 * 1024;
    private const int MaxFiles = 5000;
    private const int MaxBodyChars = 256 * 1024;

    private static readonly HashSet<string> TextExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".md", ".markdown", ".txt", ".rst", ".adoc",
        ".cs", ".csproj", ".sln", ".props", ".targets", ".razor",
        ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte",
        ".json", ".yml", ".yaml", ".xml", ".html", ".htm", ".css", ".scss", ".less",
        ".py", ".sh", ".bash", ".ps1", ".psm1", ".bat", ".cmd", ".sql",
        ".toml", ".ini", ".cfg", ".conf", ".editorconfig", ".gitignore", ".gitattributes",
        ".rs", ".go", ".java", ".kt", ".c", ".h", ".cpp", ".hpp", ".rb", ".php", ".swift",
        ".tf", ".proto", ".graphql", ".env.example",
    };

    private static readonly HashSet<string> TextNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "dockerfile", "makefile", "license", "notice", "readme", "changelog", "cmakelists.txt",
    };

    /// <summary>Walk the clone and replace the repo's rows with what is there now.</summary>
    public async Task IndexAsync(string repoId, string repoDir, CancellationToken ct = default)
    {
        // The walk happens before any transaction opens — file I/O over a whole
        // repo is the slow part, and slow work never sits inside the write lock.
        var docs = new List<(string Path, string Body)>();
        Walk(repoDir, string.Empty, docs, ct);

        var now = SqliteHelpers.FormatTimestamp(DateTimeOffset.UtcNow);
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var tx = (SqliteTransaction)await conn.BeginTransactionAsync(ct);

        await DeleteRowsAsync(conn, tx, repoId, ct);

        foreach (var (path, body) in docs)
        {
            await using var insert = conn.CreateCommand();
            insert.Transaction = tx;
            insert.CommandText = """
                INSERT INTO search_doc (kind, entity_id, book_id, chapter_id, title, body, updated_at, indexed_at)
                VALUES ($kind, $entity_id, NULL, NULL, $title, $body, $updated_at, $indexed_at)
                ON CONFLICT (kind, entity_id) DO UPDATE SET
                  title = excluded.title, body = excluded.body,
                  updated_at = excluded.updated_at, indexed_at = excluded.indexed_at
                """;
            SqliteHelpers.Add(insert, "$kind", Kind);
            SqliteHelpers.Add(insert, "$entity_id", $"{repoId}:{path}");
            // The path is the title: it is what a hit shows, and title carries a
            // 10x bm25 weight, so searching a file name finds the file first.
            SqliteHelpers.Add(insert, "$title", path);
            SqliteHelpers.Add(insert, "$body", body);
            SqliteHelpers.Add(insert, "$updated_at", now);
            SqliteHelpers.Add(insert, "$indexed_at", now);
            await insert.ExecuteNonQueryAsync(ct);
        }

        await tx.CommitAsync(ct);
        logger.LogInformation("Indexed {Count} file(s) of git repo {RepoId} for search.", docs.Count, repoId);
    }

    /// <summary>Drop every search row of one repo — unindexing, or repo deletion.</summary>
    public async Task PurgeAsync(string repoId, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var tx = (SqliteTransaction)await conn.BeginTransactionAsync(ct);
        await DeleteRowsAsync(conn, tx, repoId, ct);
        await tx.CommitAsync(ct);
    }

    private static async Task DeleteRowsAsync(
        SqliteConnection conn, SqliteTransaction tx, string repoId, CancellationToken ct)
    {
        await using var delete = conn.CreateCommand();
        delete.Transaction = tx;
        // Repo ids are NewId() hex, so the prefix carries no LIKE wildcards.
        delete.CommandText = "DELETE FROM search_doc WHERE kind = $kind AND entity_id LIKE $prefix";
        SqliteHelpers.Add(delete, "$kind", Kind);
        SqliteHelpers.Add(delete, "$prefix", repoId + ":%");
        await delete.ExecuteNonQueryAsync(ct);
    }

    private static void Walk(
        string dir, string relative, List<(string, string)> docs, CancellationToken ct)
    {
        if (docs.Count >= MaxFiles) return;
        ct.ThrowIfCancellationRequested();

        IEnumerable<string> entries;
        try
        {
            entries = Directory.EnumerateFileSystemEntries(dir);
        }
        catch (IOException)
        {
            return;
        }
        catch (UnauthorizedAccessException)
        {
            return;
        }

        foreach (var entry in entries.OrderBy(e => e, StringComparer.Ordinal))
        {
            if (docs.Count >= MaxFiles) return;
            var name = Path.GetFileName(entry);
            var info = new FileInfo(entry);
            // Symlinks are never followed — a crafted repo must not index the server.
            if (info.LinkTarget is not null) continue;

            if (Directory.Exists(entry))
            {
                if (name.Equals(".git", StringComparison.OrdinalIgnoreCase)) continue;
                if (name is "node_modules" or "bin" or "obj" or "dist" or ".venv") continue;
                Walk(entry, relative.Length == 0 ? name : relative + "/" + name, docs, ct);
                continue;
            }

            if (!IsTextCandidate(name) || info.Length == 0 || info.Length > MaxFileBytes) continue;

            string body;
            try
            {
                body = File.ReadAllText(entry);
            }
            catch (IOException)
            {
                continue;
            }

            // A NUL means the extension lied — skip binaries whatever they claim.
            if (body.Contains('\0')) continue;
            if (body.Length > MaxBodyChars) body = body[..MaxBodyChars];

            docs.Add((relative.Length == 0 ? name : relative + "/" + name, body));
        }
    }

    private static bool IsTextCandidate(string name) =>
        TextExtensions.Contains(Path.GetExtension(name)) || TextNames.Contains(name);
}

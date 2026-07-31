using System.Text;
using System.Text.RegularExpressions;
using BeeDocs.Api.Models;
using Microsoft.Data.Sqlite;

namespace BeeDocs.Api.Services;

public interface ISearchIndexService
{
    /// <summary>Create the index tables and bring the index in line with the data.</summary>
    Task InitializeAsync(CancellationToken ct = default);

    /// <summary>Apply every queued change. Cheap when the queue is empty.</summary>
    Task<int> DrainAsync(CancellationToken ct = default);

    Task<SearchResponseDto> SearchAsync(SearchQuery query, CancellationToken ct = default);

    /// <summary>Throw the index away and build it again from scratch.</summary>
    Task<SearchStatusDto> RebuildAsync(CancellationToken ct = default);

    Task<SearchStatusDto> StatusAsync(CancellationToken ct = default);
}

public sealed record SearchQuery(
    string Text,
    int Limit = 20,
    int Offset = 0,
    string? BookId = null,
    IReadOnlyList<string>? Kinds = null,
    bool Prefix = true
);

/// <summary>
/// Full-text search over books, folders, pages and diagrams.
///
/// The index is a plain <c>search_doc</c> table holding extracted text, with an
/// FTS5 table mirroring it for matching and ranking. Writes never go through this
/// service directly: triggers on the source tables record what changed in
/// <c>search_queue</c>, and the queue is drained here, immediately before a search
/// and once at startup. That keeps the index correct no matter who wrote the row —
/// the UI, the MCP server, an import, or sqlite3 on the file itself — while
/// leaving the text extraction somewhere it can actually be written.
/// </summary>
public sealed partial class SearchIndexService(
    SqliteConnectionFactory db,
    ILogger<SearchIndexService> logger
) : ISearchIndexService
{
    /// <summary>Wraps matched terms in a snippet. Private-use codepoints so no
    /// document can forge one and no HTML has to cross the wire.</summary>
    public const string HighlightOpen = "\ue000";
    public const string HighlightClose = "\ue001";

    private const int MaxLimit = 100;
    private const int DrainBatch = 500;

    /// <summary>
    /// Fold diacritics so "cafe" finds "café", and split on underscores so
    /// "revision" finds "page_revision" — technical docs are full of identifiers,
    /// and unicode61 otherwise keeps snake_case as one indivisible token.
    /// </summary>
    private const string Tokenizer = "unicode61 remove_diacritics 2 separators '_'";

    /// <summary>FTS5 when the SQLite build has it, otherwise a LIKE scan.</summary>
    private bool _fts;
    private readonly SemaphoreSlim _drainLock = new(1, 1);

    public async Task InitializeAsync(CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        _fts = await TryCreateFtsAsync(conn, ct);

        if (!_fts)
        {
            logger.LogWarning(
                "SQLite was built without FTS5 — search falls back to a LIKE scan. " +
                "Results stay correct but ranking is cruder and large libraries will be slower.");
        }

        // An existing database predates the triggers, so nothing in it has ever been
        // queued. Reconciling here backfills it, and on every later start it repairs
        // any drift left by a crash mid-write.
        await ReconcileAsync(conn, ct);
        var applied = await DrainAsync(ct);
        if (applied > 0)
            logger.LogInformation("Search index brought up to date: {Count} document(s).", applied);
    }

    private async Task<bool> TryCreateFtsAsync(SqliteConnection conn, CancellationToken ct)
    {
        try
        {
            await DropStaleFtsAsync(conn, ct);

            await using var cmd = conn.CreateCommand();
            cmd.CommandText = $"""
                CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
                  title,
                  body,
                  content='search_doc',
                  content_rowid='id',
                  prefix='2 3',
                  tokenize="{Tokenizer}"
                );

                CREATE TRIGGER IF NOT EXISTS trg_search_doc_ai AFTER INSERT ON search_doc BEGIN
                  INSERT INTO search_fts (rowid, title, body) VALUES (new.id, new.title, new.body);
                END;
                CREATE TRIGGER IF NOT EXISTS trg_search_doc_ad AFTER DELETE ON search_doc BEGIN
                  INSERT INTO search_fts (search_fts, rowid, title, body)
                  VALUES ('delete', old.id, old.title, old.body);
                END;
                CREATE TRIGGER IF NOT EXISTS trg_search_doc_au AFTER UPDATE ON search_doc BEGIN
                  INSERT INTO search_fts (search_fts, rowid, title, body)
                  VALUES ('delete', old.id, old.title, old.body);
                  INSERT INTO search_fts (rowid, title, body) VALUES (new.id, new.title, new.body);
                END;
                """;
            await cmd.ExecuteNonQueryAsync(ct);
            return true;
        }
        catch (SqliteException ex)
        {
            logger.LogDebug(ex, "FTS5 virtual table could not be created.");
            return false;
        }
    }

    /// <summary>
    /// Drop the FTS table when it was built with different options. It holds nothing
    /// that isn't derived from search_doc, so rebuilding costs only time — and a
    /// tokenizer change that is not applied would silently keep the old matching
    /// behaviour with no sign of why.
    /// </summary>
    private async Task DropStaleFtsAsync(SqliteConnection conn, CancellationToken ct)
    {
        string? existing;
        await using (var probe = conn.CreateCommand())
        {
            probe.CommandText = "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'search_fts'";
            existing = await probe.ExecuteScalarAsync(ct) as string;
        }

        if (existing is null || existing.Contains(Tokenizer, StringComparison.Ordinal)) return;

        logger.LogInformation("Search tokenizer changed — rebuilding the full-text index.");
        await using var drop = conn.CreateCommand();
        // The triggers reference the table, so they go with it and are recreated below.
        drop.CommandText = """
            DROP TRIGGER IF EXISTS trg_search_doc_ai;
            DROP TRIGGER IF EXISTS trg_search_doc_ad;
            DROP TRIGGER IF EXISTS trg_search_doc_au;
            DROP TABLE IF EXISTS search_fts;
            DELETE FROM search_doc;
            """;
        await drop.ExecuteNonQueryAsync(ct);
    }

    // -------------------------------------------------------------------------
    // Queue
    // -------------------------------------------------------------------------

    /// <summary>Queue everything the index is missing, stale on, or holding past its source.</summary>
    private static async Task ReconcileAsync(SqliteConnection conn, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT OR REPLACE INTO search_queue (kind, entity_id, op, queued_at)
            SELECT 'page', p.id, 'upsert', datetime('now')
            FROM page p
            LEFT JOIN search_doc d ON d.kind = 'page' AND d.entity_id = p.id
            WHERE d.id IS NULL OR d.updated_at <> p.updated_at;

            INSERT OR REPLACE INTO search_queue (kind, entity_id, op, queued_at)
            SELECT 'diagram', x.id, 'upsert', datetime('now')
            FROM diagram x
            LEFT JOIN search_doc d ON d.kind = 'diagram' AND d.entity_id = x.id
            WHERE d.id IS NULL OR d.updated_at <> x.updated_at;

            INSERT OR REPLACE INTO search_queue (kind, entity_id, op, queued_at)
            SELECT 'book', b.id, 'upsert', datetime('now')
            FROM book b
            LEFT JOIN search_doc d ON d.kind = 'book' AND d.entity_id = b.id
            WHERE d.id IS NULL OR d.updated_at <> b.updated_at;

            INSERT OR REPLACE INTO search_queue (kind, entity_id, op, queued_at)
            SELECT 'folder', c.id, 'upsert', datetime('now')
            FROM chapter c
            LEFT JOIN search_doc d ON d.kind = 'folder' AND d.entity_id = c.id
            WHERE d.id IS NULL OR d.updated_at <> c.updated_at;

            INSERT OR REPLACE INTO search_queue (kind, entity_id, op, queued_at)
            SELECT d.kind, d.entity_id, 'delete', datetime('now')
            FROM search_doc d
            WHERE (d.kind = 'page'    AND NOT EXISTS (SELECT 1 FROM page    WHERE id = d.entity_id))
               OR (d.kind = 'diagram' AND NOT EXISTS (SELECT 1 FROM diagram WHERE id = d.entity_id))
               OR (d.kind = 'book'    AND NOT EXISTS (SELECT 1 FROM book    WHERE id = d.entity_id))
               OR (d.kind = 'folder'  AND NOT EXISTS (SELECT 1 FROM chapter WHERE id = d.entity_id));
            """;
        await cmd.ExecuteNonQueryAsync(ct);
    }

    public async Task<int> DrainAsync(CancellationToken ct = default)
    {
        await _drainLock.WaitAsync(ct);
        try
        {
            var total = 0;
            while (true)
            {
                var applied = await DrainBatchAsync(ct);
                total += applied;
                if (applied < DrainBatch) break;
            }
            return total;
        }
        finally
        {
            _drainLock.Release();
        }
    }

    private async Task<int> DrainBatchAsync(CancellationToken ct)
    {
        await using var conn = await db.OpenConnectionAsync(ct);

        var pending = new List<(string Kind, string Id, string Op)>();
        await using (var read = conn.CreateCommand())
        {
            read.CommandText = """
                SELECT kind, entity_id, op FROM search_queue
                ORDER BY queued_at LIMIT $limit
                """;
            SqliteHelpers.Add(read, "$limit", DrainBatch);
            await using var reader = await read.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
                pending.Add((reader.GetString(0), reader.GetString(1), reader.GetString(2)));
        }

        if (pending.Count == 0) return 0;

        await using var tx = (SqliteTransaction)await conn.BeginTransactionAsync(ct);
        foreach (var (kind, id, op) in pending)
        {
            var doc = op == "delete" ? null : await LoadAsync(conn, tx, kind, id, ct);
            if (doc is null)
                await DeleteDocAsync(conn, tx, kind, id, ct);
            else
                await UpsertDocAsync(conn, tx, doc, ct);

            await using var dequeue = conn.CreateCommand();
            dequeue.Transaction = tx;
            dequeue.CommandText = "DELETE FROM search_queue WHERE kind = $kind AND entity_id = $id";
            SqliteHelpers.Add(dequeue, "$kind", kind);
            SqliteHelpers.Add(dequeue, "$id", id);
            await dequeue.ExecuteNonQueryAsync(ct);
        }
        await tx.CommitAsync(ct);
        return pending.Count;
    }

    private sealed record IndexDoc(
        string Kind,
        string EntityId,
        string? BookId,
        string? ChapterId,
        string Title,
        string Body,
        string UpdatedAt
    );

    /// <summary>Read one entity and reduce it to indexable text. Null when it is gone.</summary>
    private static async Task<IndexDoc?> LoadAsync(
        SqliteConnection conn, SqliteTransaction tx, string kind, string id, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = kind switch
        {
            "page" => "SELECT title, content, book_id, chapter_id, updated_at FROM page WHERE id = $id",
            "diagram" => "SELECT title, source, book_id, kind, updated_at FROM diagram WHERE id = $id",
            "book" => "SELECT title, description, updated_at FROM book WHERE id = $id",
            "folder" => "SELECT title, book_id, updated_at FROM chapter WHERE id = $id",
            _ => null!,
        };
        if (cmd.CommandText is null) return null;
        SqliteHelpers.Add(cmd, "$id", id);

        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) return null;

        return kind switch
        {
            "page" => new IndexDoc(
                kind, id,
                SqliteHelpers.GetNullableString(reader, 2),
                SqliteHelpers.GetNullableString(reader, 3),
                reader.GetString(0),
                SearchText.FromMarkdown(SqliteHelpers.GetNullableString(reader, 1)),
                reader.GetString(4)),

            "diagram" => new IndexDoc(
                kind, id,
                SqliteHelpers.GetNullableString(reader, 2),
                null,
                reader.GetString(0),
                SearchText.FromDiagramSource(
                    SqliteHelpers.GetNullableString(reader, 3),
                    SqliteHelpers.GetNullableString(reader, 1)),
                reader.GetString(4)),

            "book" => new IndexDoc(
                kind, id, id, null,
                reader.GetString(0),
                SqliteHelpers.GetNullableString(reader, 1) ?? "",
                reader.GetString(2)),

            "folder" => new IndexDoc(
                kind, id,
                SqliteHelpers.GetNullableString(reader, 1),
                id,
                reader.GetString(0),
                "",
                reader.GetString(2)),

            _ => null,
        };
    }

    private static async Task UpsertDocAsync(
        SqliteConnection conn, SqliteTransaction tx, IndexDoc doc, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = """
            INSERT INTO search_doc (kind, entity_id, book_id, chapter_id, title, body, updated_at, indexed_at)
            VALUES ($kind, $entity_id, $book_id, $chapter_id, $title, $body, $updated_at, $indexed_at)
            ON CONFLICT (kind, entity_id) DO UPDATE SET
              book_id = excluded.book_id,
              chapter_id = excluded.chapter_id,
              title = excluded.title,
              body = excluded.body,
              updated_at = excluded.updated_at,
              indexed_at = excluded.indexed_at
            """;
        SqliteHelpers.Add(cmd, "$kind", doc.Kind);
        SqliteHelpers.Add(cmd, "$entity_id", doc.EntityId);
        SqliteHelpers.Add(cmd, "$book_id", doc.BookId);
        SqliteHelpers.Add(cmd, "$chapter_id", doc.ChapterId);
        SqliteHelpers.Add(cmd, "$title", doc.Title);
        SqliteHelpers.Add(cmd, "$body", doc.Body);
        SqliteHelpers.Add(cmd, "$updated_at", doc.UpdatedAt);
        SqliteHelpers.Add(cmd, "$indexed_at", SqliteHelpers.FormatTimestamp(DateTimeOffset.UtcNow));
        await cmd.ExecuteNonQueryAsync(ct);
    }

    private static async Task DeleteDocAsync(
        SqliteConnection conn, SqliteTransaction tx, string kind, string id, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = "DELETE FROM search_doc WHERE kind = $kind AND entity_id = $id";
        SqliteHelpers.Add(cmd, "$kind", kind);
        SqliteHelpers.Add(cmd, "$id", id);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    // -------------------------------------------------------------------------
    // Query
    // -------------------------------------------------------------------------

    public async Task<SearchResponseDto> SearchAsync(SearchQuery query, CancellationToken ct = default)
    {
        var limit = Math.Clamp(query.Limit, 1, MaxLimit);
        var offset = Math.Max(0, query.Offset);
        var engine = _fts ? "fts5" : "like";
        var terms = Tokenize(query.Text);

        if (terms.Count == 0)
            return new SearchResponseDto(query.Text, 0, limit, offset, engine, []);

        // Results are only as fresh as the queue, so settle it first. Normally a
        // no-op; after an edit it is a handful of rows.
        await DrainAsync(ct);

        await using var conn = await db.OpenConnectionAsync(ct);
        return _fts
            ? await SearchFtsAsync(conn, query, terms, limit, offset, ct)
            : await SearchLikeAsync(conn, query, terms, limit, offset, ct);
    }

    private static async Task<SearchResponseDto> SearchFtsAsync(
        SqliteConnection conn, SearchQuery query, IReadOnlyList<string> terms,
        int limit, int offset, CancellationToken ct)
    {
        var match = BuildMatchExpression(terms, query.Prefix);
        var filter = BuildFilterSql(query, out var kinds);

        var hits = new List<SearchHitDto>();
        await using (var cmd = conn.CreateCommand())
        {
            // bm25 is negative and ascending-better; the title column is weighted
            // heavily so an exact title beats a passing mention in a long page.
            cmd.CommandText = $"""
                SELECT d.kind, d.entity_id, d.title, d.book_id, d.chapter_id, d.updated_at,
                       b.title AS book_title,
                       bm25(search_fts, 10.0, 1.0) AS score,
                       snippet(search_fts, 1, '{HighlightOpen}', '{HighlightClose}', '…', 14) AS snip
                FROM search_fts
                JOIN search_doc d ON d.id = search_fts.rowid
                LEFT JOIN book b ON b.id = d.book_id
                WHERE search_fts MATCH $match {filter}
                ORDER BY score
                LIMIT $limit OFFSET $offset
                """;
            SqliteHelpers.Add(cmd, "$match", match);
            AddFilterParameters(cmd, query, kinds);
            SqliteHelpers.Add(cmd, "$limit", limit);
            SqliteHelpers.Add(cmd, "$offset", offset);

            await using var reader = await cmd.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
                hits.Add(ReadHit(reader, scoreOrdinal: 7, snippetOrdinal: 8));
        }

        int total;
        await using (var count = conn.CreateCommand())
        {
            count.CommandText = $"""
                SELECT COUNT(*)
                FROM search_fts
                JOIN search_doc d ON d.id = search_fts.rowid
                LEFT JOIN book b ON b.id = d.book_id
                WHERE search_fts MATCH $match {filter}
                """;
            SqliteHelpers.Add(count, "$match", match);
            AddFilterParameters(count, query, kinds);
            total = Convert.ToInt32(await count.ExecuteScalarAsync(ct) ?? 0);
        }

        return new SearchResponseDto(query.Text, total, limit, offset, "fts5", hits);
    }

    /// <summary>Used only where the SQLite build lacks FTS5.</summary>
    private static async Task<SearchResponseDto> SearchLikeAsync(
        SqliteConnection conn, SearchQuery query, IReadOnlyList<string> terms,
        int limit, int offset, CancellationToken ct)
    {
        var filter = BuildFilterSql(query, out var kinds);
        var clauses = new List<string>();
        for (var i = 0; i < terms.Count; i++)
            clauses.Add($"(d.title LIKE $t{i} OR d.body LIKE $t{i})");
        var where = string.Join(" AND ", clauses);

        void AddTerms(SqliteCommand cmd)
        {
            for (var i = 0; i < terms.Count; i++)
                SqliteHelpers.Add(cmd, $"$t{i}", $"%{terms[i]}%");
        }

        var hits = new List<SearchHitDto>();
        await using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = $"""
                SELECT d.kind, d.entity_id, d.title, d.book_id, d.chapter_id, d.updated_at,
                       b.title AS book_title,
                       CASE WHEN d.title LIKE $t0 THEN -10.0 ELSE -1.0 END AS score,
                       substr(d.body, 1, 200) AS snip
                FROM search_doc d
                LEFT JOIN book b ON b.id = d.book_id
                WHERE {where} {filter}
                ORDER BY score, d.updated_at DESC
                LIMIT $limit OFFSET $offset
                """;
            AddTerms(cmd);
            AddFilterParameters(cmd, query, kinds);
            SqliteHelpers.Add(cmd, "$limit", limit);
            SqliteHelpers.Add(cmd, "$offset", offset);

            await using var reader = await cmd.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
                hits.Add(ReadHit(reader, scoreOrdinal: 7, snippetOrdinal: 8));
        }

        int total;
        await using (var count = conn.CreateCommand())
        {
            count.CommandText =
                $"SELECT COUNT(*) FROM search_doc d LEFT JOIN book b ON b.id = d.book_id WHERE {where} {filter}";
            AddTerms(count);
            AddFilterParameters(count, query, kinds);
            total = Convert.ToInt32(await count.ExecuteScalarAsync(ct) ?? 0);
        }

        return new SearchResponseDto(query.Text, total, limit, offset, "like", hits);
    }

    private static SearchHitDto ReadHit(SqliteDataReader reader, int scoreOrdinal, int snippetOrdinal)
    {
        var kind = reader.GetString(0);
        var entityId = reader.GetString(1);
        var bookId = SqliteHelpers.GetNullableString(reader, 3);

        return new SearchHitDto(
            Kind: kind,
            Id: entityId,
            Title: reader.GetString(2),
            Snippet: SqliteHelpers.GetNullableString(reader, snippetOrdinal),
            BookId: bookId,
            BookTitle: SqliteHelpers.GetNullableString(reader, 6),
            ChapterId: SqliteHelpers.GetNullableString(reader, 4),
            Url: BuildUrl(kind, entityId, bookId),
            Score: reader.IsDBNull(scoreOrdinal) ? 0 : reader.GetDouble(scoreOrdinal),
            UpdatedAt: SqliteHelpers.ReadTimestamp(reader, 5));
    }

    /// <summary>Workspace route for a hit, so clients can navigate without a lookup.</summary>
    private static string BuildUrl(string kind, string entityId, string? bookId) => kind switch
    {
        "page" when bookId is not null => $"/books/{bookId}/pages/{entityId}",
        "diagram" when bookId is not null => $"/books/{bookId}/diagrams/{entityId}",
        "folder" when bookId is not null => $"/books/{bookId}",
        "book" => $"/books/{entityId}",
        _ => "/",
    };

    private static string BuildFilterSql(SearchQuery query, out IReadOnlyList<string> kinds)
    {
        var sb = new StringBuilder();

        // Skip anything whose book is gone. Such a row cannot be opened — its
        // workspace URL points at a book that no longer exists — so returning it
        // would only produce a dead end.
        sb.Append(" AND (d.book_id IS NULL OR b.id IS NOT NULL)");

        if (!string.IsNullOrWhiteSpace(query.BookId))
            sb.Append(" AND d.book_id = $book_id");

        kinds = (query.Kinds ?? [])
            .Where(k => !string.IsNullOrWhiteSpace(k))
            .Select(k => k.Trim().ToLowerInvariant())
            .Distinct()
            .ToList();

        if (kinds.Count > 0)
        {
            var names = string.Join(", ", kinds.Select((_, i) => $"$kind{i}"));
            sb.Append(" AND d.kind IN (").Append(names).Append(')');
        }
        return sb.ToString();
    }

    private static void AddFilterParameters(SqliteCommand cmd, SearchQuery query, IReadOnlyList<string> kinds)
    {
        if (!string.IsNullOrWhiteSpace(query.BookId))
            SqliteHelpers.Add(cmd, "$book_id", query.BookId);
        for (var i = 0; i < kinds.Count; i++)
            SqliteHelpers.Add(cmd, $"$kind{i}", kinds[i]);
    }

    // -------------------------------------------------------------------------
    // Query text
    // -------------------------------------------------------------------------

    [GeneratedRegex("\"([^\"]+)\"")]
    private static partial Regex QuotedPhraseRegex();

    [GeneratedRegex(@"[^\p{L}\p{N}_]+")]
    private static partial Regex TermSplitRegex();

    /// <summary>
    /// Split raw user input into literal terms. Quoted runs survive as one term;
    /// everything else is cut on non-word characters, which also strips the FTS5
    /// operators — no input can turn into a query expression.
    /// </summary>
    internal static List<string> Tokenize(string? raw)
    {
        var terms = new List<string>();
        if (string.IsNullOrWhiteSpace(raw)) return terms;

        var rest = QuotedPhraseRegex().Replace(raw, m =>
        {
            var phrase = m.Groups[1].Value.Trim();
            if (phrase.Length > 0) terms.Add(phrase);
            return " ";
        });

        foreach (var token in TermSplitRegex().Split(rest))
        {
            if (token.Length == 0) continue;
            terms.Add(token);
        }

        // A pathological query is a denial of service, not a feature.
        return terms.Count > 16 ? terms[..16] : terms;
    }

    /// <summary>
    /// Build an FTS5 MATCH expression. Every term is quoted as a string literal, so
    /// it is matched verbatim; the last one may also match as a prefix, which is
    /// what makes as-you-type search feel instant.
    /// </summary>
    internal static string BuildMatchExpression(IReadOnlyList<string> terms, bool prefix)
    {
        var parts = new List<string>(terms.Count);
        for (var i = 0; i < terms.Count; i++)
        {
            var literal = '"' + terms[i].Replace("\"", "\"\"") + '"';
            var isLast = i == terms.Count - 1;
            // A one-character prefix would scan most of the index for nothing.
            if (prefix && isLast && terms[i].Length >= 2 && !terms[i].Contains(' '))
                literal += "*";
            parts.Add(literal);
        }
        return string.Join(" AND ", parts);
    }

    // -------------------------------------------------------------------------
    // Maintenance
    // -------------------------------------------------------------------------

    public async Task<SearchStatusDto> RebuildAsync(CancellationToken ct = default)
    {
        await using (var conn = await db.OpenConnectionAsync(ct))
        {
            await using var tx = (SqliteTransaction)await conn.BeginTransactionAsync(ct);
            await using (var clear = conn.CreateCommand())
            {
                clear.Transaction = tx;
                // Deleting search_doc rows drives the FTS triggers, so both sides go.
                clear.CommandText = "DELETE FROM search_doc; DELETE FROM search_queue;";
                await clear.ExecuteNonQueryAsync(ct);
            }
            await tx.CommitAsync(ct);

            await ReconcileAsync(conn, ct);
        }

        await DrainAsync(ct);

        if (_fts)
        {
            await using var conn = await db.OpenConnectionAsync(ct);
            await using var optimize = conn.CreateCommand();
            optimize.CommandText = "INSERT INTO search_fts(search_fts) VALUES('rebuild');";
            await optimize.ExecuteNonQueryAsync(ct);
        }

        return await StatusAsync(ct);
    }

    public async Task<SearchStatusDto> StatusAsync(CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT
              (SELECT COUNT(*) FROM search_doc),
              (SELECT COUNT(*) FROM search_queue),
              (SELECT COUNT(*) FROM search_doc WHERE kind = 'page'),
              (SELECT COUNT(*) FROM search_doc WHERE kind = 'diagram'),
              (SELECT COUNT(*) FROM search_doc WHERE kind = 'book'),
              (SELECT COUNT(*) FROM search_doc WHERE kind = 'folder'),
              (SELECT MAX(indexed_at) FROM search_doc)
            """;
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct))
            return new SearchStatusDto(_fts ? "fts5" : "like", 0, 0, 0, 0, 0, 0, null);

        var lastIndexed = SqliteHelpers.GetNullableString(reader, 6) is { } raw
            && DateTimeOffset.TryParse(raw, out var parsed)
                ? parsed
                : (DateTimeOffset?)null;

        return new SearchStatusDto(
            Engine: _fts ? "fts5" : "like",
            Documents: reader.GetInt32(0),
            Pending: reader.GetInt32(1),
            Pages: reader.GetInt32(2),
            Diagrams: reader.GetInt32(3),
            Books: reader.GetInt32(4),
            Folders: reader.GetInt32(5),
            LastIndexedAt: lastIndexed);
    }
}

using BeeDocs.Api.Models;
using Microsoft.Data.Sqlite;

namespace BeeDocs.Api.Services;

public interface IStatsService
{
    /// <summary>Instance-wide numbers for the Statistics page. <paramref name="days"/> bounds the per-day series and the "recent" per-user counts.</summary>
    Task<InstanceStatsDto> GetStatsAsync(int days = 30, CancellationToken ct = default);
}

/// <summary>
/// Read-only aggregates over the live tables — no counters are maintained
/// anywhere, so this can never drift from the data and needs no migration.
/// Everything is computed per request; on a SQLite file that comfortably fits
/// in cache, that is a handful of milliseconds, not a job queue.
/// </summary>
public sealed class StatsService(SqliteConnectionFactory db, StorageOptions storage) : IStatsService
{
    public async Task<InstanceStatsDto> GetStatsAsync(int days = 30, CancellationToken ct = default)
    {
        var windowDays = Math.Clamp(days, 1, 365);
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        // Timestamps are stored as ISO-8601 UTC text, so a date-only prefix
        // compares correctly against them ('2026-08-15T…' >= '2026-08-15').
        var cutoff = today.AddDays(-(windowDays - 1)).ToString("yyyy-MM-dd");

        await using var conn = await db.OpenConnectionAsync(ct);

        var documents = await CountsAsync(conn, ct);
        var storageStats = await StorageAsync(conn, ct);
        var activity = await ActivityAsync(conn, cutoff, windowDays, today, ct);
        var users = await UsersAsync(conn, cutoff, ct);

        return new InstanceStatsDto(
            Documents: documents,
            Storage: storageStats,
            WindowDays: windowDays,
            Activity: activity,
            Users: users,
            GeneratedAt: DateTimeOffset.UtcNow);
    }

    private static async Task<DocumentCountsDto> CountsAsync(SqliteConnection conn, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT (SELECT COUNT(*) FROM shelf),
                   (SELECT COUNT(*) FROM book),
                   (SELECT COUNT(*) FROM chapter),
                   (SELECT COUNT(*) FROM page),
                   (SELECT COUNT(*) FROM diagram),
                   (SELECT COUNT(*) FROM slide_deck)
            """;
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        await reader.ReadAsync(ct);
        var pages = reader.GetInt32(3);
        var diagrams = reader.GetInt32(4);
        var decks = reader.GetInt32(5);
        return new DocumentCountsDto(
            Shelves: reader.GetInt32(0),
            Books: reader.GetInt32(1),
            Chapters: reader.GetInt32(2),
            Pages: pages,
            Diagrams: diagrams,
            SlideDecks: decks,
            Total: pages + diagrams + decks);
    }

    private async Task<StorageStatsDto> StorageAsync(SqliteConnection conn, CancellationToken ct)
    {
        // LENGTH() on TEXT counts characters; casting to BLOB counts the bytes
        // actually stored (SQLite keeps text as UTF-8).
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT (SELECT COALESCE(SUM(LENGTH(CAST(content AS BLOB))), 0) FROM page)
                 + (SELECT COALESCE(SUM(LENGTH(CAST(source AS BLOB))), 0) FROM diagram)
                 + (SELECT COALESCE(SUM(LENGTH(CAST(source AS BLOB))), 0) FROM slide_deck),
                   (SELECT COALESCE(SUM(LENGTH(CAST(content AS BLOB))), 0) FROM page_revision),
                   (SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size())
            """;
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        await reader.ReadAsync(ct);
        var contentBytes = reader.GetInt64(0);
        var revisionBytes = reader.GetInt64(1);
        var logicalDbBytes = reader.GetInt64(2);

        return new StorageStatsDto(
            ContentBytes: contentBytes,
            RevisionBytes: revisionBytes,
            DatabaseBytes: DatabaseFileBytes(logicalDbBytes),
            UploadsBytes: UploadsBytes());
    }

    /// <summary>
    /// What the database costs on disk: the main file plus its -wal/-shm
    /// companions, since a checkpointed-behind WAL can hold much of the data.
    /// The logical size (page_count × page_size) stands in when the store is
    /// not a plain file (:memory:, exotic URIs).
    /// </summary>
    private long DatabaseFileBytes(long logicalBytes)
    {
        var path = new SqliteConnectionStringBuilder(db.ConnectionString).DataSource;
        if (string.IsNullOrWhiteSpace(path) || path.Contains(":memory:"))
            return logicalBytes;

        var total = 0L;
        foreach (var candidate in new[] { path, path + "-wal", path + "-shm" })
        {
            var info = new FileInfo(candidate);
            if (info.Exists) total += info.Length;
        }
        return total > 0 ? total : logicalBytes;
    }

    private long UploadsBytes()
    {
        try
        {
            var dir = new DirectoryInfo(storage.UploadsRoot);
            if (!dir.Exists) return 0;
            return dir.EnumerateFiles("*", SearchOption.AllDirectories).Sum(f => f.Length);
        }
        catch (IOException)
        {
            return 0;
        }
    }

    private static async Task<IReadOnlyList<DailyActivityDto>> ActivityAsync(
        SqliteConnection conn, string cutoff, int windowDays, DateOnly today, CancellationToken ct)
    {
        var created = new Dictionary<string, int>();
        var updated = new Dictionary<string, int>();

        await using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = """
                SELECT SUBSTR(created_at, 1, 10) AS day, COUNT(*)
                FROM (SELECT created_at FROM page
                      UNION ALL SELECT created_at FROM diagram
                      UNION ALL SELECT created_at FROM slide_deck)
                WHERE created_at >= $cutoff
                GROUP BY day
                """;
            SqliteHelpers.Add(cmd, "$cutoff", cutoff);
            await using var reader = await cmd.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
                created[reader.GetString(0)] = reader.GetInt32(1);
        }

        // Page updates come from the change log, so every sitting in the window
        // counts even if the page has been edited again since. Diagrams and
        // slide decks keep no log, so only their latest update is visible — each
        // contributes at most one to the day it was last touched (creation day
        // excluded; a document is not "updated" by being created).
        await using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = """
                SELECT day, SUM(n) FROM (
                  SELECT SUBSTR(created_at, 1, 10) AS day, COUNT(DISTINCT page_id) AS n
                  FROM page_revision
                  WHERE change_kind = 'updated' AND created_at >= $cutoff
                  GROUP BY day
                  UNION ALL
                  SELECT SUBSTR(updated_at, 1, 10) AS day, COUNT(*) AS n
                  FROM (SELECT created_at, updated_at FROM diagram
                        UNION ALL SELECT created_at, updated_at FROM slide_deck)
                  WHERE updated_at >= $cutoff
                    AND SUBSTR(updated_at, 1, 10) != SUBSTR(created_at, 1, 10)
                  GROUP BY day)
                GROUP BY day
                """;
            SqliteHelpers.Add(cmd, "$cutoff", cutoff);
            await using var reader = await cmd.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
                updated[reader.GetString(0)] = reader.GetInt32(1);
        }

        // Zero-filled and oldest-first: the chart draws one bar per day whether
        // or not anything happened, so quiet stretches stay visible.
        var series = new List<DailyActivityDto>(windowDays);
        for (var i = windowDays - 1; i >= 0; i--)
        {
            var day = today.AddDays(-i).ToString("yyyy-MM-dd");
            series.Add(new DailyActivityDto(
                Day: day,
                Created: created.GetValueOrDefault(day),
                Updated: updated.GetValueOrDefault(day)));
        }
        return series;
    }

    private static async Task<IReadOnlyList<UserActivityDto>> UsersAsync(
        SqliteConnection conn, string cutoff, CancellationToken ct)
    {
        // One row per author in the page change log — the current account name
        // when the account still exists, otherwise the name captured with the
        // change. NULL changed_by groups anonymous and API-key changes each
        // under the snapshot name they carry.
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT r.changed_by,
                   COALESCE(NULLIF(TRIM(u.display_name), ''), u.username,
                            MAX(r.changed_by_name), 'Anonymous') AS name,
                   COUNT(*) AS changes,
                   COUNT(DISTINCT r.page_id) AS pages,
                   SUM(CASE WHEN r.created_at >= $cutoff THEN 1 ELSE 0 END) AS recent,
                   MAX(r.created_at) AS last
            FROM page_revision r
            LEFT JOIN app_user u ON u.id = r.changed_by
            GROUP BY r.changed_by,
                     CASE WHEN r.changed_by IS NULL THEN COALESCE(r.changed_by_name, '') ELSE '' END
            ORDER BY recent DESC, changes DESC, name
            """;
        SqliteHelpers.Add(cmd, "$cutoff", cutoff);

        var users = new List<UserActivityDto>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            users.Add(new UserActivityDto(
                UserId: SqliteHelpers.GetNullableString(reader, 0),
                Name: reader.GetString(1),
                Changes: reader.GetInt32(2),
                PagesTouched: reader.GetInt32(3),
                ChangesInWindow: reader.GetInt32(4),
                LastActiveAt: SqliteHelpers.ReadTimestamp(reader, 5)));
        }
        return users;
    }
}

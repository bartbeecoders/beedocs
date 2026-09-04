using BeeDocs.Api.Models;

namespace BeeDocs.Api.Services;

public interface IFavoriteService
{
    /// <summary>The calling user's favorites, newest-starred first.</summary>
    Task<IReadOnlyList<FavoriteDto>> ListAsync(CancellationToken ct = default);

    /// <summary>
    /// Star an item. Idempotent — starring twice is one favorite. False when
    /// the target does not exist.
    /// </summary>
    Task<bool> AddAsync(string kind, string entityId, CancellationToken ct = default);

    /// <summary>Unstar an item. False when it was not a favorite.</summary>
    Task<bool> RemoveAsync(string kind, string entityId, CancellationToken ct = default);
}

/// <summary>
/// A user's starred books, pages, diagrams, slide decks and attachments.
/// Favorites are scoped per account via <see cref="ICurrentUserAccessor"/>; when
/// sign-in is off (or the caller is the API key) there is no account and the
/// whole instance shares one list under the empty-string key — the same
/// degradation ownership follows. Rows whose target is deleted are removed by
/// triggers in <see cref="DatabaseInitializer"/>, whoever does the deleting.
/// </summary>
public sealed class FavoriteService(SqliteConnectionFactory db, ICurrentUserAccessor currentUser) : IFavoriteService
{
    /// <summary>Kind → its own table. Also the list of valid kinds.</summary>
    private static readonly Dictionary<string, string> KindTables = new()
    {
        ["book"] = "book",
        ["page"] = "page",
        ["diagram"] = "diagram",
        ["slides"] = "slide_deck",
        ["kanban"] = "kanban_board",
        ["attachment"] = "attachment",
    };

    public static bool IsValidKind(string kind) => KindTables.ContainsKey(kind);

    public static string KindList => string.Join(", ", KindTables.Keys);

    /// <summary>'' rather than null: the key is half the primary key.</summary>
    private string UserKey => currentUser.Current.Id ?? string.Empty;

    public async Task<IReadOnlyList<FavoriteDto>> ListAsync(CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        // One join per kind, each guarded by f.kind so ids can never collide
        // across tables. The triggers keep targets from vanishing under a row,
        // but the NULL-title filter makes a stray row invisible rather than a
        // blank panel entry.
        cmd.CommandText = """
            SELECT f.kind, f.entity_id,
                   COALESCE(b.title, p.title, d.title, s.title, k.title, a.title) AS title,
                   COALESCE(p.book_id, d.book_id, s.book_id, k.book_id, a.book_id) AS book_id,
                   f.created_at
            FROM favorite f
            LEFT JOIN book b ON f.kind = 'book' AND b.id = f.entity_id
            LEFT JOIN page p ON f.kind = 'page' AND p.id = f.entity_id
            LEFT JOIN diagram d ON f.kind = 'diagram' AND d.id = f.entity_id
            LEFT JOIN slide_deck s ON f.kind = 'slides' AND s.id = f.entity_id
            LEFT JOIN kanban_board k ON f.kind = 'kanban' AND k.id = f.entity_id
            LEFT JOIN attachment a ON f.kind = 'attachment' AND a.id = f.entity_id
            WHERE f.user_id = $user
              AND COALESCE(b.title, p.title, d.title, s.title, k.title, a.title) IS NOT NULL
            ORDER BY f.created_at DESC, f.entity_id
            """;
        SqliteHelpers.Add(cmd, "$user", UserKey);

        var list = new List<FavoriteDto>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            list.Add(new FavoriteDto(
                Kind: reader.GetString(0),
                EntityId: reader.GetString(1),
                Title: reader.GetString(2),
                BookId: SqliteHelpers.GetNullableString(reader, 3),
                CreatedAt: SqliteHelpers.ReadTimestamp(reader, 4)));
        }
        return list;
    }

    public async Task<bool> AddAsync(string kind, string entityId, CancellationToken ct = default)
    {
        if (!KindTables.TryGetValue(kind, out var table))
            throw new ArgumentException($"Unknown favorite kind '{kind}'.", nameof(kind));

        await using var conn = await db.OpenConnectionAsync(ct);

        // Existence first, separately: INSERT OR IGNORE alone cannot tell "the
        // target is gone" (a 404) apart from "already starred" (fine).
        await using (var probe = conn.CreateCommand())
        {
            // The table name is from KindTables, never from the caller.
            probe.CommandText = $"SELECT 1 FROM {table} WHERE id = $id LIMIT 1";
            SqliteHelpers.Add(probe, "$id", entityId);
            if (await probe.ExecuteScalarAsync(ct) is null) return false;
        }

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT OR IGNORE INTO favorite (user_id, kind, entity_id, created_at)
            VALUES ($user, $kind, $id, $created_at)
            """;
        SqliteHelpers.Add(cmd, "$user", UserKey);
        SqliteHelpers.Add(cmd, "$kind", kind);
        SqliteHelpers.Add(cmd, "$id", entityId);
        SqliteHelpers.Add(cmd, "$created_at", SqliteHelpers.FormatTimestamp(DateTimeOffset.UtcNow));
        await cmd.ExecuteNonQueryAsync(ct);
        return true;
    }

    public async Task<bool> RemoveAsync(string kind, string entityId, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "DELETE FROM favorite WHERE user_id = $user AND kind = $kind AND entity_id = $id";
        SqliteHelpers.Add(cmd, "$user", UserKey);
        SqliteHelpers.Add(cmd, "$kind", kind);
        SqliteHelpers.Add(cmd, "$id", entityId);
        return await cmd.ExecuteNonQueryAsync(ct) > 0;
    }
}

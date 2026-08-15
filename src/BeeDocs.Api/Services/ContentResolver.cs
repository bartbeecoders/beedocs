using Microsoft.Data.Sqlite;

namespace BeeDocs.Api.Services;

/// <summary>
/// What a save produced: the value for the inline column, and the ref/size
/// columns beside it. Exactly one of InlineValue / ContentRef carries the body.
/// </summary>
public sealed record ContentCell(string InlineValue, string? ContentRef, long? ContentSize);

/// <summary>
/// The one place domain services touch content offloading. Reads follow the
/// row's own <c>content_ref</c>; writes follow the owning shelf's provider flag.
/// Provider I/O always happens here — callers do it before opening their SQLite
/// transaction, so a slow upload never holds the write lock.
/// </summary>
public sealed class ContentResolver(ContentStoreRouter router, ILogger<ContentResolver> logger)
{
    /// <summary>
    /// The body of a row: the inline column, or a provider fetch when the row is
    /// offloaded. Throws <see cref="ContentUnavailableException"/> when the
    /// provider cannot be reached — metadata callers should not call this.
    /// </summary>
    public async Task<string> LoadAsync(string inline, string? contentRef, CancellationToken ct = default)
    {
        if (!ContentRef.TryParse(contentRef, out var providerId, out var key))
            return inline;
        var store = await router.ResolveAsync(providerId, ct);
        return await store.GetAsync(key, ct);
    }

    /// <summary>
    /// Place a body according to the target provider. Null target → inline,
    /// byte-for-byte the pre-feature behavior. A provider failure is logged and
    /// falls back to inline: the user's text always lands durably in SQLite and
    /// the row self-describes, so the next good save (or a move re-run)
    /// re-offloads it. Never throws for provider trouble.
    /// </summary>
    public async Task<ContentCell> SaveAsync(
        string body,
        string? targetProviderId,
        string suggestedKey,
        string? oldRef,
        CancellationToken ct = default)
    {
        if (string.IsNullOrEmpty(targetProviderId))
            return new(body, null, null);

        try
        {
            var store = await router.ResolveAsync(targetProviderId, ct);
            // In-place update is only meaningful at the provider that assigned
            // the old key (Drive file ids); anywhere else it is a fresh object.
            var existingKey = ContentRef.TryParse(oldRef, out var oldProvider, out var oldKey)
                && oldProvider == targetProviderId ? oldKey : null;
            var key = await store.PutAsync(suggestedKey, body, existingKey, ct);
            return new(string.Empty, ContentRef.Format(targetProviderId, key), ByteCount(body));
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex,
                "Storing content at provider {ProviderId} failed; keeping the body inline in SQLite", targetProviderId);
            return new(body, null, null);
        }
    }

    /// <summary>
    /// Best-effort removal of an object a row no longer points at. Call after
    /// the SQLite write committed — never before, or a rolled-back write leaves
    /// the row pointing at a deleted object. Orphans are tolerated: keys are
    /// deterministic, so a future re-offload overwrites them.
    /// </summary>
    public async Task DeleteAsync(string? contentRef, CancellationToken ct = default)
    {
        if (!ContentRef.TryParse(contentRef, out var providerId, out var key))
            return;
        try
        {
            var store = await router.ResolveAsync(providerId, ct);
            await store.DeleteAsync(key, ct);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Deleting {Ref} from its storage provider failed; object orphaned", contentRef);
        }
    }

    /// <summary>Each ref in turn, best-effort — see <see cref="DeleteAsync"/>.</summary>
    public async Task DeleteAllAsync(IEnumerable<string> contentRefs, CancellationToken ct = default)
    {
        foreach (var @ref in contentRefs)
            await DeleteAsync(@ref, ct);
    }

    /// <summary>
    /// After a save: drop the object the row used to point at, when the new cell
    /// points elsewhere (moved provider, or fell back inline).
    /// </summary>
    public Task CleanupReplacedAsync(string? oldRef, string? newRef, CancellationToken ct = default) =>
        oldRef is not null && oldRef != newRef ? DeleteAsync(oldRef, ct) : Task.CompletedTask;

    /// <summary>Where new writes for this book's content go: its shelf's provider, or null for local.</summary>
    public static async Task<string?> ProviderIdForBookAsync(
        SqliteConnection conn, string bookId, CancellationToken ct = default)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT s.storage_provider_id
            FROM book b LEFT JOIN shelf s ON s.id = b.shelf_id
            WHERE b.id = $id
            """;
        SqliteHelpers.Add(cmd, "$id", bookId);
        return await cmd.ExecuteScalarAsync(ct) as string;
    }

    private static long ByteCount(string body) => System.Text.Encoding.UTF8.GetByteCount(body);
}

using System.Collections.Concurrent;
using Azure;
using Azure.Storage.Blobs;
using BeeDocs.Api.Models;

namespace BeeDocs.Api.Services;

/// <summary>
/// One storage backend holding content bodies as text objects. Implementations
/// are constructed per provider row by <see cref="ContentStoreRouter"/> and hold
/// that row's credentials.
/// </summary>
public interface IContentStore
{
    /// <summary>
    /// Store a body and return the opaque key to record after the
    /// <c>"{providerId}:"</c> prefix of a content ref. Backends that address
    /// objects by name return <paramref name="suggestedKey"/> unchanged; backends
    /// that assign ids (Google Drive) update in place when
    /// <paramref name="existingKey"/> names one of their objects and return the id.
    /// </summary>
    Task<string> PutAsync(string suggestedKey, string body, string? existingKey, CancellationToken ct);

    Task<string> GetAsync(string key, CancellationToken ct);

    /// <summary>Idempotent — a missing object counts as deleted.</summary>
    Task DeleteAsync(string key, CancellationToken ct);

    /// <summary>Round-trips a probe object. Failures come back as Ok = false, never thrown.</summary>
    Task<StorageTestResultDto> TestAsync(CancellationToken ct);
}

/// <summary>One object at a backup target, as listed under the backup prefix.</summary>
public sealed record StoredObject(string Key, long Size, DateTimeOffset? LastModified);

/// <summary>
/// The binary, name-addressed side of a storage provider, used by backups. Kept
/// apart from <see cref="IContentStore"/> because the two have different
/// contracts: content bodies are text under provider-assigned keys (Drive file
/// ids), a backup archive is bytes under a name the caller chose and can list
/// again later. Every provider kind implements both.
/// </summary>
public interface IBackupStore
{
    /// <summary>Store bytes under <paramref name="key"/>, replacing any object of that name.</summary>
    Task UploadAsync(string key, Stream content, long length, CancellationToken ct);

    /// <summary>Copy the object into <paramref name="destination"/>. Throws <see cref="ContentUnavailableException"/> when missing.</summary>
    Task DownloadAsync(string key, Stream destination, CancellationToken ct);

    /// <summary>Every object whose key starts with <paramref name="prefix"/>, in no particular order.</summary>
    Task<IReadOnlyList<StoredObject>> ListAsync(string prefix, CancellationToken ct);

    /// <summary>Idempotent — a missing object counts as deleted.</summary>
    Task DeleteAsync(string key, CancellationToken ct);
}

/// <summary>
/// The <c>"{providerId}:{key}"</c> format of a <c>content_ref</c> column, and the
/// deterministic keys content is filed under. Keys are provider- and
/// shelf-independent so moving a book between shelves never renames objects.
/// </summary>
public static class ContentRef
{
    public static string Format(string providerId, string key) => $"{providerId}:{key}";

    /// <summary>Provider ids are Guid-N (no colons), so the first colon splits reliably.</summary>
    public static bool TryParse(string? @ref, out string providerId, out string key)
    {
        providerId = string.Empty;
        key = string.Empty;
        if (string.IsNullOrEmpty(@ref)) return false;
        var idx = @ref.IndexOf(':');
        if (idx <= 0 || idx == @ref.Length - 1) return false;
        providerId = @ref[..idx];
        key = @ref[(idx + 1)..];
        return true;
    }

    public static string PageKey(string pageId) => $"page/{pageId}";
    public static string RevisionKey(string revisionId) => $"rev/{revisionId}";
    public static string DiagramKey(string diagramId) => $"diagram/{diagramId}";
    public static string SlideDeckKey(string deckId) => $"slides/{deckId}";
    public static string KanbanKey(string boardId) => $"kanban/{boardId}";
    public static string ProjectKey(string planId) => $"project/{planId}";
    public static string NoteKey(string noteId) => $"notes/{noteId}";
}

/// <summary>
/// A content body could not be fetched from (or written to, where a write cannot
/// fall back) its storage provider. Program.cs maps this to a 503 naming the
/// provider, so the failure reads as "fix the provider", not "the page is gone".
/// </summary>
public sealed class ContentUnavailableException(string providerName, string message, Exception? inner = null)
    : Exception(message, inner)
{
    public string ProviderName { get; } = providerName;
}

/// <summary>Azure Blob Storage backend: one blob per body, addressed by the suggested key.</summary>
public sealed class AzureBlobContentStore : IContentStore, IBackupStore
{
    private readonly BlobContainerClient _container;
    private readonly string _providerName;
    private volatile bool _containerEnsured;

    public AzureBlobContentStore(string connectionString, string container, string providerName)
    {
        _container = new BlobContainerClient(connectionString, container);
        _providerName = providerName;
    }

    public async Task<string> PutAsync(string suggestedKey, string body, string? existingKey, CancellationToken ct)
    {
        await EnsureContainerAsync(ct);
        await _container.GetBlobClient(suggestedKey)
            .UploadAsync(BinaryData.FromString(body), overwrite: true, ct);
        return suggestedKey;
    }

    public async Task<string> GetAsync(string key, CancellationToken ct)
    {
        try
        {
            var result = await _container.GetBlobClient(key).DownloadContentAsync(ct);
            return result.Value.Content.ToString();
        }
        catch (RequestFailedException ex)
        {
            throw new ContentUnavailableException(
                _providerName, $"Azure Blob Storage returned {ex.Status} for '{key}'.", ex);
        }
    }

    public async Task DeleteAsync(string key, CancellationToken ct) =>
        await _container.GetBlobClient(key).DeleteIfExistsAsync(cancellationToken: ct);

    public async Task<StorageTestResultDto> TestAsync(CancellationToken ct)
    {
        try
        {
            const string probeKey = "._beedocs-probe";
            await PutAsync(probeKey, "probe", null, ct);
            await GetAsync(probeKey, ct);
            await DeleteAsync(probeKey, ct);
            return new(true, $"Connected. Container '{_container.Name}' is writable.");
        }
        catch (Exception ex)
        {
            return new(false, Root(ex).Message);
        }
    }

    public async Task UploadAsync(string key, Stream content, long length, CancellationToken ct)
    {
        await EnsureContainerAsync(ct);
        await _container.GetBlobClient(key).UploadAsync(content, overwrite: true, ct);
    }

    public async Task DownloadAsync(string key, Stream destination, CancellationToken ct)
    {
        try
        {
            await _container.GetBlobClient(key).DownloadToAsync(destination, ct);
        }
        catch (RequestFailedException ex)
        {
            throw new ContentUnavailableException(
                _providerName, $"Azure Blob Storage returned {ex.Status} for '{key}'.", ex);
        }
    }

    public async Task<IReadOnlyList<StoredObject>> ListAsync(string prefix, CancellationToken ct)
    {
        try
        {
            var list = new List<StoredObject>();
            await foreach (var blob in _container.GetBlobsAsync(Azure.Storage.Blobs.Models.BlobTraits.None, Azure.Storage.Blobs.Models.BlobStates.None, prefix, ct))
                list.Add(new StoredObject(blob.Name, blob.Properties.ContentLength ?? 0, blob.Properties.LastModified));
            return list;
        }
        catch (RequestFailedException ex)
        {
            throw new ContentUnavailableException(
                _providerName, $"Azure Blob Storage returned {ex.Status} listing '{prefix}'.", ex);
        }
    }

    private async Task EnsureContainerAsync(CancellationToken ct)
    {
        if (_containerEnsured) return;
        await _container.CreateIfNotExistsAsync(cancellationToken: ct);
        _containerEnsured = true;
    }

    internal static Exception Root(Exception ex) => ex.GetBaseException();
}

/// <summary>
/// Resolves a provider id to a live <see cref="IContentStore"/>. Store instances
/// are cached per provider and invalidated by the row's <c>updated_at</c> —
/// auto-save resolves every 1.5 seconds and the underlying clients are
/// heavyweight, so constructing one per call is not an option.
/// </summary>
public sealed class ContentStoreRouter(IStorageProviderService providers)
{
    private readonly ConcurrentDictionary<string, (DateTimeOffset UpdatedAt, IContentStore Store)> _cache = new();

    public async Task<IContentStore> ResolveAsync(string providerId, CancellationToken ct = default)
    {
        var secret = await providers.ResolveAsync(providerId, ct)
            ?? throw new ContentUnavailableException(
                "unknown provider", $"Storage provider '{providerId}' no longer exists.");

        if (!secret.IsReady)
            throw new ContentUnavailableException(secret.Name, NotReadyMessage(secret));

        if (_cache.TryGetValue(providerId, out var cached) && cached.UpdatedAt == secret.UpdatedAt)
            return cached.Store;

        var store = Create(secret);
        _cache[providerId] = (secret.UpdatedAt, store);
        return store;
    }

    /// <summary>
    /// The backup side of a provider. Same cache as <see cref="ResolveAsync"/>:
    /// every store implements both interfaces, so one instance serves both.
    /// </summary>
    public async Task<IBackupStore> ResolveBackupAsync(string providerId, CancellationToken ct = default) =>
        (IBackupStore)await ResolveAsync(providerId, ct);

    /// <summary>Drop every cached client — after a restore replaced the provider rows underneath them.</summary>
    public void Clear() => _cache.Clear();

    /// <summary>Why a provider cannot answer, phrased for the admin who has to fix it.</summary>
    public static string NotReadyMessage(StorageProviderSecret secret) => secret.Kind switch
    {
        StorageProviderKinds.GoogleDrive =>
            $"Storage provider '{secret.Name}' is not connected — reconnect Google Drive in Settings.",
        StorageProviderKinds.S3 =>
            $"Storage provider '{secret.Name}' is missing its bucket, access key or secret key — complete it in Settings.",
        _ => $"Storage provider '{secret.Name}' has no connection string — add one in Settings.",
    };

    /// <summary>Builds a store for a secret already in hand (the test endpoint, which must not cache).</summary>
    public static IContentStore Create(StorageProviderSecret secret) => secret.Kind switch
    {
        StorageProviderKinds.AzureBlob => new AzureBlobContentStore(
            secret.AzureConnectionString!, secret.AzureContainer, secret.Name),
        StorageProviderKinds.GoogleDrive => new GoogleDriveContentStore(secret),
        StorageProviderKinds.S3 => new S3ContentStore(secret),
        _ => throw new ContentUnavailableException(
            secret.Name, $"Unknown storage provider kind '{secret.Kind}'."),
    };
}

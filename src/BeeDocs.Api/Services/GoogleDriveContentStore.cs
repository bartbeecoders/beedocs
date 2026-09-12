using System.Text;
using BeeDocs.Api.Models;
using Google;
using Google.Apis.Auth.OAuth2;
using Google.Apis.Auth.OAuth2.Flows;
using Google.Apis.Auth.OAuth2.Responses;
using Google.Apis.Drive.v3;
using Google.Apis.Services;
using Google.Apis.Upload;

namespace BeeDocs.Api.Services;

/// <summary>
/// Google Drive backend. Files live in the folder the OAuth callback ensured and
/// are addressed by Drive's own file ids — which is exactly why content refs
/// store an opaque key instead of a derived name. The SDK refreshes access
/// tokens from the stored refresh token by itself.
/// </summary>
public sealed class GoogleDriveContentStore : IContentStore, IBackupStore
{
    private readonly DriveService _drive;
    private readonly string _folderId;
    private readonly string _providerName;

    public GoogleDriveContentStore(StorageProviderSecret secret)
    {
        _providerName = secret.Name;
        _folderId = secret.GoogleFolderId ?? string.Empty;
        _drive = CreateService(secret);
    }

    /// <summary>Also used by the OAuth callback, which has a fresh token instead of a stored one.</summary>
    public static DriveService CreateService(StorageProviderSecret secret) =>
        new(new BaseClientService.Initializer
        {
            HttpClientInitializer = new UserCredential(
                CreateFlow(secret.GoogleClientId!, secret.GoogleClientSecret!),
                "beedocs",
                new TokenResponse { RefreshToken = secret.GoogleRefreshToken }),
            ApplicationName = "BeeDocs",
        });

    public static GoogleAuthorizationCodeFlow CreateFlow(string clientId, string clientSecret) =>
        new(new GoogleAuthorizationCodeFlow.Initializer
        {
            ClientSecrets = new ClientSecrets { ClientId = clientId, ClientSecret = clientSecret },
            Scopes = [DriveService.Scope.DriveFile],
        });

    public async Task<string> PutAsync(string suggestedKey, string body, string? existingKey, CancellationToken ct)
    {
        try
        {
            using var stream = new MemoryStream(Encoding.UTF8.GetBytes(body));

            if (!string.IsNullOrEmpty(existingKey))
            {
                var update = _drive.Files.Update(new Google.Apis.Drive.v3.Data.File(), existingKey, stream, "text/plain");
                var updated = await update.UploadAsync(ct);
                if (updated.Status == UploadStatus.Completed) return existingKey;
                // The old file may have been deleted on Drive directly; fall
                // through and create a fresh one rather than failing the save.
                if (updated.Exception is not GoogleApiException { HttpStatusCode: System.Net.HttpStatusCode.NotFound })
                    throw Wrap(updated.Exception ?? new InvalidOperationException("Drive upload did not complete."));
                stream.Position = 0;
            }

            var meta = new Google.Apis.Drive.v3.Data.File
            {
                Name = suggestedKey.Replace('/', '-') + ".txt",
                MimeType = "text/plain",
                Parents = string.IsNullOrEmpty(_folderId) ? null : [_folderId],
            };
            var create = _drive.Files.Create(meta, stream, "text/plain");
            create.Fields = "id";
            var progress = await create.UploadAsync(ct);
            if (progress.Status != UploadStatus.Completed)
                throw Wrap(progress.Exception ?? new InvalidOperationException("Drive upload did not complete."));
            return create.ResponseBody.Id;
        }
        catch (Exception ex) when (ex is not ContentUnavailableException)
        {
            throw Wrap(ex);
        }
    }

    public async Task<string> GetAsync(string key, CancellationToken ct)
    {
        try
        {
            using var stream = new MemoryStream();
            var progress = await _drive.Files.Get(key).DownloadAsync(stream, ct);
            if (progress.Status != Google.Apis.Download.DownloadStatus.Completed)
                throw Wrap(progress.Exception ?? new InvalidOperationException("Drive download did not complete."));
            return Encoding.UTF8.GetString(stream.ToArray());
        }
        catch (Exception ex) when (ex is not ContentUnavailableException)
        {
            throw Wrap(ex);
        }
    }

    public async Task DeleteAsync(string key, CancellationToken ct)
    {
        try
        {
            await _drive.Files.Delete(key).ExecuteAsync(ct);
        }
        catch (GoogleApiException ex) when (ex.HttpStatusCode == System.Net.HttpStatusCode.NotFound)
        {
            // Already gone — deletion is idempotent.
        }
    }

    // ----- IBackupStore: archives are addressed by *name* inside the folder -----
    // Content bodies use Drive's own file ids because the row records whatever
    // key PutAsync returns; a backup has to be found again by the name it was
    // given, so these look the file up by name first.

    public async Task UploadAsync(string key, Stream content, long length, CancellationToken ct)
    {
        try
        {
            var existing = await FindByNameAsync(key, ct);
            if (existing is not null)
            {
                var update = _drive.Files.Update(new Google.Apis.Drive.v3.Data.File(), existing.Id, content, "application/zip");
                var updated = await update.UploadAsync(ct);
                if (updated.Status == UploadStatus.Completed) return;
                if (updated.Exception is not GoogleApiException { HttpStatusCode: System.Net.HttpStatusCode.NotFound })
                    throw Wrap(updated.Exception ?? new InvalidOperationException("Drive upload did not complete."));
                content.Position = 0;
            }

            var meta = new Google.Apis.Drive.v3.Data.File
            {
                Name = key,
                MimeType = "application/zip",
                Parents = string.IsNullOrEmpty(_folderId) ? null : [_folderId],
            };
            var create = _drive.Files.Create(meta, content, "application/zip");
            create.Fields = "id";
            var progress = await create.UploadAsync(ct);
            if (progress.Status != UploadStatus.Completed)
                throw Wrap(progress.Exception ?? new InvalidOperationException("Drive upload did not complete."));
        }
        catch (Exception ex) when (ex is not ContentUnavailableException)
        {
            throw Wrap(ex);
        }
    }

    public async Task DownloadAsync(string key, Stream destination, CancellationToken ct)
    {
        try
        {
            var file = await FindByNameAsync(key, ct)
                ?? throw new ContentUnavailableException(_providerName, $"Google Drive has no file named '{key}'.");
            var progress = await _drive.Files.Get(file.Id).DownloadAsync(destination, ct);
            if (progress.Status != Google.Apis.Download.DownloadStatus.Completed)
                throw Wrap(progress.Exception ?? new InvalidOperationException("Drive download did not complete."));
        }
        catch (Exception ex) when (ex is not ContentUnavailableException)
        {
            throw Wrap(ex);
        }
    }

    public async Task<IReadOnlyList<StoredObject>> ListAsync(string prefix, CancellationToken ct)
    {
        try
        {
            var list = new List<StoredObject>();
            string? pageToken = null;
            do
            {
                var req = _drive.Files.List();
                // Drive has no starts-with; 'contains' narrows server-side and the
                // prefix check below makes it exact.
                req.Q = $"'{_folderId}' in parents and trashed = false and name contains '{Escape(prefix)}'";
                req.Fields = "nextPageToken, files(id, name, size, modifiedTimeDateTimeOffset)";
                req.PageSize = 200;
                req.PageToken = pageToken;
                var page = await req.ExecuteAsync(ct);
                foreach (var f in page.Files ?? [])
                {
                    if (!f.Name.StartsWith(prefix, StringComparison.Ordinal)) continue;
                    list.Add(new StoredObject(f.Name, f.Size ?? 0, f.ModifiedTimeDateTimeOffset));
                }
                pageToken = page.NextPageToken;
            } while (!string.IsNullOrEmpty(pageToken));
            return list;
        }
        catch (Exception ex) when (ex is not ContentUnavailableException)
        {
            throw Wrap(ex);
        }
    }

    /// <summary>Delete-by-name for the backup side; the content side's <see cref="DeleteAsync"/> takes a file id.</summary>
    async Task IBackupStore.DeleteAsync(string key, CancellationToken ct)
    {
        try
        {
            var file = await FindByNameAsync(key, ct);
            if (file is not null) await DeleteAsync(file.Id, ct);
        }
        catch (Exception ex) when (ex is not ContentUnavailableException)
        {
            throw Wrap(ex);
        }
    }

    private async Task<Google.Apis.Drive.v3.Data.File?> FindByNameAsync(string name, CancellationToken ct)
    {
        var req = _drive.Files.List();
        req.Q = $"'{_folderId}' in parents and trashed = false and name = '{Escape(name)}'";
        req.Fields = "files(id, name)";
        req.PageSize = 2;
        var page = await req.ExecuteAsync(ct);
        return page.Files?.FirstOrDefault(f => f.Name == name);
    }

    private static string Escape(string value) => value.Replace("\\", "\\\\").Replace("'", "\\'");

    public async Task<StorageTestResultDto> TestAsync(CancellationToken ct)
    {
        try
        {
            if (string.IsNullOrEmpty(_folderId))
                return new(false, "Not connected yet — click Connect to authorize Google Drive.");
            var get = _drive.Files.Get(_folderId);
            get.Fields = "id, name";
            var folder = await get.ExecuteAsync(ct);
            return new(true, $"Connected. Content is stored in Drive folder '{folder.Name}'.");
        }
        catch (Exception ex)
        {
            return new(false, ex.GetBaseException().Message);
        }
    }

    private ContentUnavailableException Wrap(Exception ex) => ex switch
    {
        TokenResponseException => new ContentUnavailableException(
            _providerName,
            $"Google Drive rejected the stored authorization for '{_providerName}' — reconnect it in Settings.",
            ex),
        _ => new ContentUnavailableException(
            _providerName, $"Google Drive request failed: {ex.GetBaseException().Message}", ex),
    };
}

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
public sealed class GoogleDriveContentStore : IContentStore
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
